import { keywordResearchTask } from "../../trigger/glossary/keyword-research";
import { createTestRunner } from "./index";

/**
 * Test cases for keyword research functionality
 * This test specifically focuses on reproducing the issue reported in GitHub issue #4
 * where the keyword research task fails for the term "RESTful API"
 */
export const keywordResearchTestRunner = createTestRunner({
  id: "test_keyword_research",
  task: keywordResearchTask,
  testCases: [
    {
      name: "Should handle RESTful API term without failure",
      input: {
        term: "RESTful API",
        onCacheHit: "revalidate" as const,
      },
      validate: (result) => {
        // The test should pass if:
        // 1. The task completes without throwing an error
        // 2. The result has the expected structure
        if (!result.ok) {
          console.error("❌ Task failed:", result.error);
          return false;
        }
        
        console.info("✅ Task completed successfully");
        console.info(`Keywords found: ${result.output.keywords.length}`);
        
        // Validate output structure
        if (!result.output.keywords || !Array.isArray(result.output.keywords)) {
          console.error("❌ Invalid keywords structure");
          return false;
        }
        
        if (!result.output.term) {
          console.error("❌ Missing term in output");
          return false;
        }
        
        return true;
      }
    },
    {
      name: "Should handle empty markdown content gracefully",
      input: {
        term: "EmptyContentTest",
        onCacheHit: "revalidate" as const,
      },
      validate: (result) => {
        // This test checks if the function handles cases where
        // firecrawl responses might have empty or malformed markdown
        if (!result.ok) {
          console.warn("⚠️ Task failed for empty content test - this reveals the bug");
          return false; // This is expected to fail currently due to the bug
        }
        
        console.info("✅ Handled empty content gracefully");
        return true;
      }
    },
    {
      name: "Should handle malformed search results",
      input: {
        term: "MalformedTest",
        onCacheHit: "revalidate" as const,
      },
      validate: (result) => {
        // This test checks error handling for malformed data
        if (!result.ok) {
          console.warn("⚠️ Task failed for malformed test - this reveals the bug");
          return false; // This is expected to fail currently due to the bug
        }
        
        return true;
      }
    }
  ]
});

/**
 * Standalone test function to isolate the getOrCreateKeywordsFromHeaders issue
 * This directly tests the problematic function without going through the full workflow
 */
export async function testKeywordsFromHeadersIsolated() {
  console.info("🧪 Testing getOrCreateKeywordsFromHeaders in isolation...");
  
  try {
    // Import the function that's likely causing the issue
    const { getOrCreateKeywordsFromHeaders } = await import("../keywords");
    
    // Test with a term that might not have firecrawl results in the database
    const result = await getOrCreateKeywordsFromHeaders({ term: "RESTful API" });
    
    console.info("✅ getOrCreateKeywordsFromHeaders completed successfully");
    console.info(`Keywords extracted: ${result.length}`);
    
    return { success: true, keywordCount: result.length };
  } catch (error) {
    console.error("❌ getOrCreateKeywordsFromHeaders failed:", error);
    
    if (error instanceof Error) {
      console.error("Error message:", error.message);
      console.error("Error stack:", error.stack);
    }
    
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Test to check if firecrawl responses are properly stored and queryable
 */
export async function testFirecrawlDataIntegrity() {
  console.info("🔍 Testing firecrawl data integrity...");
  
  try {
    const { db } = await import("../db-marketing/client");
    const { firecrawlResponses } = await import("../db-marketing/schemas");
    const { eq } = await import("drizzle-orm");
    
    // Check if there are any firecrawl responses for "RESTful API"
    const responses = await db.query.firecrawlResponses.findMany({
      where: eq(firecrawlResponses.inputTerm, "RESTful API"),
    });
    
    console.info(`Found ${responses.length} firecrawl responses for "RESTful API"`);
    
    // Check if any responses have valid markdown content
    const responsesWithMarkdown = responses.filter(r => r.markdown && r.markdown.length > 0);
    console.info(`${responsesWithMarkdown.length} responses have markdown content`);
    
    // Check if any responses have headers that can be extracted
    const responsesWithHeaders = responses.filter(r => 
      r.markdown && r.markdown.match(/^##\s+(.*)$/gm)
    );
    console.info(`${responsesWithHeaders.length} responses have extractable headers`);
    
    return {
      totalResponses: responses.length,
      withMarkdown: responsesWithMarkdown.length,
      withHeaders: responsesWithHeaders.length,
      samples: responses.slice(0, 2).map(r => ({
        sourceUrl: r.sourceUrl,
        hasMarkdown: !!r.markdown,
        markdownLength: r.markdown?.length || 0,
        hasError: !!r.error,
        error: r.error
      }))
    };
  } catch (error) {
    console.error("❌ Firecrawl data integrity test failed:", error);
    return { error: error instanceof Error ? error.message : String(error) };
  }
}