import { db } from "@/lib/db-marketing/client";
import { keywords } from "@/lib/db-marketing/schemas";
import { getOrCreateFirecrawlResponsesSequentially } from "@/lib/firecrawl";
import { AbortTaskRunError, task } from "@trigger.dev/sdk/v3";
import { sql } from "drizzle-orm";
import { inArray } from "drizzle-orm";
import { and, eq } from "drizzle-orm";
import { getOrCreateKeywordsFromHeaders, getOrCreateKeywordsFromTitles } from "../../lib/keywords";
import { getOrCreateSearchQuery } from "../../lib/search-query";
import { getOrCreateSearchResponse } from "../../lib/serper";
import type { CacheStrategy } from "./_generate-glossary-entry";

export const THREE = 3;

export const keywordResearchTask = task({
  id: "keyword_research",
  retry: {
    maxAttempts: 3,
  },
  run: async ({
    term,
    onCacheHit = "stale" as CacheStrategy,
  }: { term: string; onCacheHit?: CacheStrategy }) => {
    const existing = await db.query.keywords.findMany({
      where: eq(keywords.inputTerm, term),
    });

    if (existing.length > 0 && onCacheHit === "stale") {
      return {
        message: `Found existing keywords for ${term}`,
        term,
        keywords: existing,
      };
    }

    const entryWithSearchQuery = await getOrCreateSearchQuery({ term, onCacheHit });
    const searchQuery = entryWithSearchQuery?.searchQuery;
    console.info(`1/6 - SEARCH QUERY: ${searchQuery?.query}`);

    if (!searchQuery) {
      throw new AbortTaskRunError("Unable to generate search query");
    }

    const searchResponse = await getOrCreateSearchResponse({
      query: searchQuery.query,
      inputTerm: searchQuery.inputTerm,
    });
    console.info(
      `2/6 - SEARCH RESPONSE: Found ${searchResponse.serperOrganicResults.length} organic results`,
    );

    console.info(`3/6 - Getting content for top ${THREE} results (sequentially to avoid rate limits)`);
    const topThree = searchResponse.serperOrganicResults
      .sort((a, b) => a.position - b.position)
      .slice(0, THREE);

    // Get content for top 3 results sequentially to avoid rate limiting
    const firecrawlResults = await getOrCreateFirecrawlResponsesSequentially(
      topThree.map((result) => ({
        url: result.link,
        connectTo: { term: term }
      })),
      1500 // 1.5 second delay between requests
    );

    const successfulResults = firecrawlResults.filter(result => result?.success);
    const failedResults = firecrawlResults.filter(result => !result?.success);
    
    console.info(`4/6 - Found ${firecrawlResults.length} firecrawl results (${successfulResults.length} successful, ${failedResults.length} failed)`);
    
    if (failedResults.length > 0) {
      console.warn(`⚠️ Some URLs failed to scrape: ${failedResults.map(r => r?.sourceUrl).join(', ')}`);
    }

    const keywordsFromTitles = await getOrCreateKeywordsFromTitles({
      term: term,
    });
    console.info(`5/6 - KEYWORDS FROM TITLES: ${keywordsFromTitles.length} keywords`);

    const keywordsFromHeaders = await getOrCreateKeywordsFromHeaders({
      term: term,
    });

    console.info(`6/6 - KEYWORDS FROM HEADERS: ${keywordsFromHeaders.length} keywords`);

    // NB: drizzle doesn't support returning ids in conjunction with handling duplicates, so we get them afterwards
    await db
      .insert(keywords)
      .values(
        searchResponse.serperRelatedSearches.map((search) => ({
          inputTerm: searchQuery.inputTerm,
          keyword: search.query.toLowerCase(),
          source: "related_searches",
          updatedAt: sql`CURRENT_TIMESTAMP(3)`,
        })),
      )
      .onDuplicateKeyUpdate({
        set: {
          updatedAt: sql`CURRENT_TIMESTAMP(3)`,
        },
      });
    const insertedRelatedSearches = await db.query.keywords.findMany({
      where: and(
        eq(keywords.inputTerm, searchQuery.inputTerm),
        eq(keywords.source, "related_searches"),
        inArray(
          keywords.keyword,
          searchResponse.serperRelatedSearches.map((search) => search.query.toLowerCase()),
        ),
      ),
    });

    const totalKeywords = keywordsFromTitles.length + keywordsFromHeaders.length + insertedRelatedSearches.length;
    const resultSummary = `${successfulResults.length}/${topThree.length} URLs scraped successfully`;
    
    console.info(
      `✅ Keyword Research for ${term} completed. Total keywords: ${totalKeywords} (${resultSummary})`,
    );

    return {
      message: `Keyword Research for ${term} completed (${resultSummary})`,
      term: searchQuery.inputTerm,
      keywords: [...keywordsFromTitles, ...keywordsFromHeaders, ...insertedRelatedSearches],
      entry: entryWithSearchQuery,
      firecrawlStats: {
        total: firecrawlResults.length,
        successful: successfulResults.length,
        failed: failedResults.length,
      },
    };
  },
});
