import { db } from "@/lib/db-marketing/client";
import { keywords } from "@/lib/db-marketing/schemas";
import { getOrCreateFirecrawlResponse } from "@/lib/firecrawl";
import { AbortTaskRunError, task } from "@trigger.dev/sdk/v3";
import { sql } from "drizzle-orm";
import { inArray } from "drizzle-orm";
import { and, eq } from "drizzle-orm";
import { getOrCreateKeywordsFromHeaders, getOrCreateKeywordsFromTitles } from "../../lib/keywords";
import { getOrCreateSearchQuery } from "../../lib/search-query";
import { getOrCreateSearchResponse } from "../../lib/serper";
import type { CacheStrategy } from "./_generate-glossary-entry";

export const THREE = 3;

/**
 * Individual task for scraping a single URL with rate limiting protection.
 * This task is used with batch processing for concurrent URL scraping.
 */
export const scrapeUrlTask = task({
  id: "scrape_url_batch",
  retry: {
    maxAttempts: 3,
  },
  run: async (payload: {
    url: string;
    connectTo: { term: string };
  }) => {
    const result = await getOrCreateFirecrawlResponse(payload);
    
    return {
      url: payload.url,
      success: result?.success || false,
      error: result?.error || null,
      hasContent: Boolean(result?.markdown),
      result,
    };
  },
});

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

    console.info(`3/6 - Getting content for top ${THREE} results using batch processing`);
    const topThree = searchResponse.serperOrganicResults
      .sort((a, b) => a.position - b.position)
      .slice(0, THREE);

    // Use batch processing to handle multiple URLs concurrently with rate limiting
    const batchResults = await scrapeUrlTask.batchTriggerAndWait(
      topThree.map((result) => ({
        payload: {
          url: result.link,
          connectTo: { term: term }
        }
      }))
    );

    // Process batch results
    const firecrawlResults = [];
    const successfulResults = [];
    const failedResults = [];

    for (const batchResult of batchResults) {
      if (batchResult.ok) {
        firecrawlResults.push(batchResult.output.result);
        if (batchResult.output.success) {
          successfulResults.push(batchResult.output);
        } else {
          failedResults.push(batchResult.output);
        }
      } else {
        console.error(`Batch task failed for URL: ${JSON.stringify(batchResult)}`);
        failedResults.push({
          url: 'unknown',
          success: false,
          error: 'Batch task execution failed',
          hasContent: false
        });
      }
    }
    
    console.info(`4/6 - Found ${firecrawlResults.length} firecrawl results (${successfulResults.length} successful, ${failedResults.length} failed)`);
    
    if (failedResults.length > 0) {
      console.warn(`⚠️ Some URLs failed to scrape: ${failedResults.map(r => r.url).join(', ')}`);
      failedResults.forEach(failed => {
        if (failed.error) {
          console.warn(`  - ${failed.url}: ${failed.error}`);
        }
      });
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
        searchResponse.serperRelatedSearches.map((search: { query: string }) => ({
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
          searchResponse.serperRelatedSearches.map((search: { query: string }) => search.query.toLowerCase()),
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
        failedUrls: failedResults.map(r => ({ url: r.url, error: r.error })),
      },
    };
  },
});
