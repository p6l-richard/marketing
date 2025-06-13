import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { sql } from "drizzle-orm";
import { and } from "drizzle-orm";
import { inArray } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db-marketing/client";
import { firecrawlResponses, keywords, serperSearchResponses } from "./db-marketing/schemas";

export const keywordResearchSystemPrompt = `
You are an SEO Expert & Content Writer specializing in creating technical content for Developer Tools that are highly SEO optimized.

**Your Objectives:**
1. **Keyword Extraction:**
   - Extract relevant keywords from the titles of top-ranking organic search results.
   - Focus on technical and context-specific terms related to API development.

2. **Quality Assurance:**
   - **Remove Stopwords:** Ensure that keywords do not include common stopwords (e.g., "for," "and," "the," "of," etc.).
   - **Remove Brand Names:** Ensure that keywords do not include brand names (e.g., "GitHub", "YouTube", "npm", etc.).
   - **Remove README keywords:** Ensure to exclude from instructive headers or titles (e.g., "getting started", "installation", etc.) of readmes.

**Guidelines:**
- Prioritize keywords that directly relate to the main term and its subtopics.
- Maintain a focus on terms that potential users or developers are likely to search for in the context of API development.
- Branded keywords should be included in the keywordsWithBrandNames and not in the keywords.
`;

export async function getOrCreateKeywordsFromTitles(args: { term: string }) {
  const { term } = args;
  const existing = await db.query.keywords.findMany({
    where: and(eq(keywords.inputTerm, term)),
  });
  if (existing.length > 0) {
    return existing;
  }

  const searchResponse = await db.query.serperSearchResponses.findFirst({
    where: eq(serperSearchResponses.inputTerm, term),
    with: {
      serperOrganicResults: true,
    },
  });
  if (!searchResponse) {
    throw new Error(
      `Error attempting to get keywords from firecrawl results: No search response found for term ${term}`,
    );
  }

  const promptTitles = `Below is a list of titles separated by semicolons (';') from the top organic search results currently ranking for the term '${term}'.
          Given that some pages might be SEO optimized, there's a chance that we can extract keywords from the page titles.
          Create a list of keywords that are directly related to the main term and its subtopics form the titles of the pages.

          Given that some title contain the brand of the website (e.g. github, youtube, etc.) OR the section of the website (e.g. blog, docs, etc.), ensure to not treat them as keywords.

          ==========
          ${searchResponse.serperOrganicResults
            .map(
              (result) =>
                `The title for the sourceUrl "${result.link}" (reference this url as the sourceUrl for the keyword) is: "${result.title}"`,
            )
            .join(";")}
          ==========
          `;
  // extract keywords from the title of the organic results
  const keywordsFromTitles = await generateObject({
    model: openai("gpt-4o-mini"),
    system: keywordResearchSystemPrompt,
    prompt: promptTitles,
    schema: z.object({
      keywords: z.array(z.object({ keyword: z.string(), sourceUrl: z.string().url() })),
      keywordsWithBrandNames: z.array(
        z.object({ keyword: z.string(), sourceUrl: z.string().url() }),
      ),
    }),
  });

  // NB: drizzle doesn't support returning ids in conjunction with handling duplicates, so we get them afterwards
  await db
    .insert(keywords)
    .values(
      keywordsFromTitles.object.keywords.map((keyword) => ({
        inputTerm: term,
        keyword: keyword.keyword.toLowerCase(),
        sourceUrl: keyword.sourceUrl,
        source: "titles",
      })),
    )
    .onDuplicateKeyUpdate({
      set: {
        updatedAt: sql`CURRENT_TIMESTAMP(3)`,
      },
    });

  return db.query.keywords.findMany({
    where: and(
      eq(keywords.inputTerm, term),
      eq(keywords.source, "titles"),
      inArray(
        keywords.keyword,
        keywordsFromTitles.object.keywords.map((k) => k.keyword.toLowerCase()),
      ),
    ),
  });
}

export async function getOrCreateKeywordsFromHeaders(args: { term: string }) {
  const { term } = args;
  
  try {
    // Check if we already have keywords from headers for this term
    const existing = await db.query.keywords.findMany({
      where: and(eq(keywords.inputTerm, term), eq(keywords.source, "headers")),
    });
    if (existing.length > 0) {
      console.info(`✓ Found ${existing.length} existing keywords from headers for term: ${term}`);
      return existing;
    }

    // Get firecrawl responses for this term
    const firecrawlResults = await db.query.firecrawlResponses.findMany({
      where: eq(firecrawlResponses.inputTerm, term),
    });

    console.info(`Found ${firecrawlResults.length} firecrawl responses for term: ${term}`);

    // Validate firecrawl results
    if (firecrawlResults.length === 0) {
      console.warn(`⚠️ No firecrawl responses found for term: ${term}. Returning empty keywords array.`);
      return [];
    }

    // Filter for responses with valid markdown content
    const validResponses = firecrawlResults.filter(response => {
      if (!response.markdown || response.markdown.length === 0) {
        console.warn(`⚠️ Firecrawl response for ${response.sourceUrl} has no markdown content`);
        return false;
      }
      if (response.error) {
        console.warn(`⚠️ Firecrawl response for ${response.sourceUrl} has error: ${response.error}`);
        return false;
      }
      return true;
    });

    console.info(`${validResponses.length} firecrawl responses have valid markdown content`);

    if (validResponses.length === 0) {
      console.warn(`⚠️ No valid firecrawl responses with markdown content for term: ${term}. Returning empty keywords array.`);
      return [];
    }

    // Extract headers from markdown content
    const responsesWithHeaders = validResponses.filter(response => {
      const headers = response.markdown?.match(/^##\s+(.*)$/gm);
      if (!headers || headers.length === 0) {
        console.info(`ℹ️ No H2 headers found in ${response.sourceUrl}`);
        return false;
      }
      return true;
    });

    console.info(`${responsesWithHeaders.length} responses have extractable H2 headers`);

    if (responsesWithHeaders.length === 0) {
      console.warn(`⚠️ No firecrawl responses with extractable headers for term: ${term}. Returning empty keywords array.`);
      return [];
    }

    // Build context for LLM
    const context = responsesWithHeaders
      .map((firecrawlResponse) => {
        const headers = firecrawlResponse.markdown?.match(/^##\s+(.*)$/gm);
        if (!headers) return "";
        
        return `
          ==========
          The headers for the organic result "${firecrawlResponse.sourceUrl}" (ensure you're referencing this url as the sourceUrl for the keyword) are:
          ${headers.join("\n")}
          ==========
          `;
      })
      .filter(contextPart => contextPart.length > 0)
      .join(";");

    if (context.length === 0) {
      console.warn(`⚠️ Empty context generated for term: ${term}. Returning empty keywords array.`);
      return [];
    }

    const promptHeaders = `Below is a list of h2 headers, separated by semicolons (';'), from the top organic search results currently ranking for the term '${term}'. Given that some pages might be SEO optimized, there's a chance that we can extract keywords from them.
          Create a list of keywords that are directly related to the main term and its subtopics form the h2 headers of the pages.

          ==========
          ${context}
          ==========
          `;

    // Call OpenAI API with error handling
    let keywordsFromHeaders;
    try {
      console.info(`🤖 Calling OpenAI API to extract keywords from headers for term: ${term}`);
      keywordsFromHeaders = await generateObject({
        model: openai("gpt-4o-mini"),
        system: keywordResearchSystemPrompt,
        prompt: promptHeaders,
        schema: z.object({
          keywords: z.array(z.object({ keyword: z.string(), sourceUrl: z.string().url() })),
          keywordsWithBrandNames: z.array(
            z.object({ keyword: z.string(), sourceUrl: z.string().url() }),
          ),
        }),
      });
      console.info(`✓ OpenAI API call successful, extracted ${keywordsFromHeaders.object.keywords.length} keywords`);
    } catch (error) {
      console.error(`❌ OpenAI API call failed for term: ${term}`, error);
      console.warn(`⚠️ Gracefully continuing without keywords from headers for term: ${term}`);
      return [];
    }

    // Validate OpenAI response
    if (!keywordsFromHeaders.object.keywords || keywordsFromHeaders.object.keywords.length === 0) {
      console.warn(`⚠️ OpenAI returned no keywords for term: ${term}. Returning empty array.`);
      return [];
    }

    // Store keywords in database with error handling
    try {
      await db
        .insert(keywords)
        .values(
          keywordsFromHeaders.object.keywords.map((keyword) => ({
            inputTerm: term,
            keyword: keyword.keyword.toLowerCase(),
            sourceUrl: keyword.sourceUrl,
            source: "headers",
          })),
        )
        .onDuplicateKeyUpdate({
          set: {
            updatedAt: sql`CURRENT_TIMESTAMP(3)`,
          },
        });
      
      console.info(`✓ Successfully stored ${keywordsFromHeaders.object.keywords.length} keywords from headers`);
    } catch (error) {
      console.error(`❌ Failed to store keywords in database for term: ${term}`, error);
      // Return the keywords even if we can't store them, so the workflow can continue
      return keywordsFromHeaders.object.keywords.map((keyword, index) => ({
        id: `temp-${index}`, // Temporary ID for keywords that couldn't be stored
        inputTerm: term,
        keyword: keyword.keyword.toLowerCase(),
        sourceUrl: keyword.sourceUrl,
        source: "headers" as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
    }

    // Return stored keywords
    const storedKeywords = await db.query.keywords.findMany({
      where: and(
        eq(keywords.inputTerm, term),
        eq(keywords.source, "headers"),
        inArray(
          keywords.keyword,
          keywordsFromHeaders.object.keywords.map((k) => k.keyword.toLowerCase()),
        ),
      ),
    });

    console.info(`✓ Retrieved ${storedKeywords.length} stored keywords from headers for term: ${term}`);
    return storedKeywords;

  } catch (error) {
    // Catch-all error handler to ensure the function never throws
    console.error(`❌ Unexpected error in getOrCreateKeywordsFromHeaders for term: ${term}`, error);
    console.warn(`⚠️ Gracefully continuing without keywords from headers for term: ${term}`);
    return [];
  }
}
