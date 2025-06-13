import { db } from "@/lib/db-marketing/client";
import { firecrawlResponses } from "@/lib/db-marketing/schemas";
import FirecrawlApp from "@mendable/firecrawl-js";
import { eq } from "drizzle-orm";

const firecrawl = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_API_KEY!,
});

/**
 * Utility function to wait for a specified amount of time
 */
function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Checks if an error is a rate limit error (429 status)
 */
function isRateLimitError(error: any): boolean {
  return error?.statusCode === 429 || 
         (error?.message && error.message.includes('429')) ||
         (error?.status === 429);
}

/**
 * Implements exponential backoff retry logic specifically for rate limit errors
 */
async function retryWithExponentialBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: any;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // If it's not a rate limit error, don't retry
      if (!isRateLimitError(error)) {
        throw error;
      }
      
      // If we've exhausted all retries, throw the last error
      if (attempt === maxRetries) {
        console.error(`Failed after ${maxRetries + 1} attempts due to rate limiting:`, error);
        throw error;
      }
      
      // Calculate delay with exponential backoff and jitter
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
      console.warn(`Rate limited (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms...`);
      
      await wait(delay);
    }
  }
  
  throw lastError;
}

// Type for Firecrawl scrape result
type FirecrawlScrapeResult = {
  success: boolean;
  error?: string;
  markdown?: string;
  metadata?: {
    sourceURL?: string;
    scrapeId?: string;
    title?: string;
    description?: string;
    language?: string;
    ogTitle?: string;
    ogDescription?: string;
    ogUrl?: string;
    ogImage?: string;
    ogSiteName?: string;
  };
};

/**
 * Gets or creates a firecrawl response for a given URL.
 * First checks if we already have the content, if not scrapes it.
 * Includes rate limiting protection with exponential backoff.
 */
export async function getOrCreateFirecrawlResponse(args: {
  url: string;
  connectTo: { term: string };
}) {
  // 1. Check if we already have this URL
  const existing = await db.query.firecrawlResponses.findFirst({
    where: eq(firecrawlResponses.sourceUrl, args.url),
  });
  if (existing?.markdown) {
    console.info(`Cache hit for URL: ${args.url}`);
    return existing;
  }

  // 2. If not, scrape the URL with rate limiting protection
  try {
    console.info(`Scraping URL: ${args.url}`);
    
    const firecrawlResult = await retryWithExponentialBackoff<FirecrawlScrapeResult>(
      () => firecrawl.scrapeUrl(args.url, { formats: ["markdown"] }) as Promise<FirecrawlScrapeResult>,
      3, // max retries
      2000 // base delay of 2 seconds
    );

    // 3. Handle scraping failure
    if (!firecrawlResult.success) {
      const [response] = await db
        .insert(firecrawlResponses)
        .values({
          sourceUrl: args.url,
          error: firecrawlResult.error || "Unknown error occurred",
          success: false,
          inputTerm: args.connectTo.term || "",
        })
        .onDuplicateKeyUpdate({
          set: {
            error: firecrawlResult.error || "Unknown error occurred",
            success: false,
            updatedAt: new Date(), // Fixed: was updatedAtM
          },
        })
        .$returningId();

      console.warn(
        `⚠️ Failed to scrape URL ${args.url}: ${firecrawlResult.error}. Stored error in DB with id '${response.id}'`,
      );
      return await db.query.firecrawlResponses.findFirst({
        where: eq(firecrawlResponses.sourceUrl, args.url),
      });
    }

    // 4. Store successful result
    await db
      .insert(firecrawlResponses)
      .values({
        success: firecrawlResult.success,
        markdown: firecrawlResult.markdown ?? null,
        sourceUrl: firecrawlResult.metadata?.sourceURL || args.url,
        scrapeId: firecrawlResult.metadata?.scrapeId || "",
        title: firecrawlResult.metadata?.title || "",
        description: firecrawlResult.metadata?.description || "",
        language: firecrawlResult.metadata?.language || "",
        ogTitle: firecrawlResult.metadata?.ogTitle || "",
        ogDescription: firecrawlResult.metadata?.ogDescription || "",
        ogUrl: firecrawlResult.metadata?.ogUrl || "",
        ogImage: firecrawlResult.metadata?.ogImage || "",
        ogSiteName: firecrawlResult.metadata?.ogSiteName || "",
        error: null,
        inputTerm: args.connectTo.term || "",
      })
      .onDuplicateKeyUpdate({
        set: {
          markdown: firecrawlResult.markdown ?? null,
          success: true,
          error: null,
          updatedAt: new Date(), // Fixed: was using Date.now()
        },
      });

    console.info(`✅ Successfully scraped URL: ${args.url}`);
    return await db.query.firecrawlResponses.findFirst({
      where: eq(firecrawlResponses.sourceUrl, args.url),
    });
  } catch (error) {
    // 5. Handle unexpected errors (including rate limit errors that exhausted retries)
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isRateLimit = isRateLimitError(error);
    
    console.error(`${isRateLimit ? 'Rate limit' : 'Error'} processing URL ${args.url}:`, error);

    // Store the error and return the response
    await db
      .insert(firecrawlResponses)
      .values({
        sourceUrl: args.url,
        error: errorMessage,
        success: false,
        inputTerm: args.connectTo.term || "",
      })
      .onDuplicateKeyUpdate({
        set: {
          error: errorMessage,
          success: false,
          updatedAt: new Date(), // Fixed: was using Date.now()
        },
      });

    // Return the failed response instead of throwing
    // This allows the workflow to continue with partial failures
    return await db.query.firecrawlResponses.findFirst({
      where: eq(firecrawlResponses.sourceUrl, args.url),
    });
  }
}

/**
 * Processes multiple URLs sequentially to avoid rate limiting.
 * Use this instead of Promise.all() when making multiple Firecrawl requests.
 */
export async function getOrCreateFirecrawlResponsesSequentially(
  requests: Array<{ url: string; connectTo: { term: string } }>,
  delayBetweenRequests: number = 1000
): Promise<Array<Awaited<ReturnType<typeof getOrCreateFirecrawlResponse>>>> {
  const results = [];
  
  console.info(`Processing ${requests.length} URLs sequentially with ${delayBetweenRequests}ms delay between requests`);
  
  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];
    console.info(`Processing URL ${i + 1}/${requests.length}: ${request.url}`);
    
    const result = await getOrCreateFirecrawlResponse(request);
    results.push(result);
    
    // Add delay between requests (except for the last one)
    if (i < requests.length - 1) {
      await wait(delayBetweenRequests);
    }
  }
  
  const successCount = results.filter(r => r?.success).length;
  const errorCount = results.length - successCount;
  
  console.info(`✅ Completed processing ${requests.length} URLs: ${successCount} successful, ${errorCount} failed`);
  
  return results;
}
