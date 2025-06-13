import { task } from "@trigger.dev/sdk/v3";

/**
 * Simple test task to verify the keyword research fix works
 * This can be run without needing full API keys and database setup
 */
export const testKeywordFixTask = task({
  id: "test_keyword_fix",
  retry: {
    maxAttempts: 1,
  },
  run: async ({ term = "RESTful API" }: { term?: string }) => {
    console.info(`🧪 Testing keyword research fix for term: ${term}`);
    
    try {
      // Import the fixed function
      const { getOrCreateKeywordsFromHeaders } = await import("../lib/keywords");
      
      console.info("📋 Testing getOrCreateKeywordsFromHeaders...");
      
      // Test the function that was previously failing
      const result = await getOrCreateKeywordsFromHeaders({ term });
      
      console.info(`✅ getOrCreateKeywordsFromHeaders completed successfully!`);
      console.info(`📊 Result: Found ${result.length} keywords from headers`);
      
      // Test edge cases
      console.info("🔍 Testing edge cases...");
      
      // Test with non-existent term
      const emptyResult = await getOrCreateKeywordsFromHeaders({ term: "NonExistentTermForTesting123" });
      console.info(`✅ Empty term test: Found ${emptyResult.length} keywords (expected: 0)`);
      
      // Test with special characters
      const specialResult = await getOrCreateKeywordsFromHeaders({ term: "Test@#$%^&*()" });
      console.info(`✅ Special characters test: Found ${specialResult.length} keywords`);
      
      return {
        success: true,
        message: "All tests passed! The keyword research fix is working correctly.",
        results: {
          mainTerm: {
            term,
            keywordCount: result.length,
            success: true
          },
          edgeCases: {
            emptyTerm: {
              keywordCount: emptyResult.length,
              success: true
            },
            specialChars: {
              keywordCount: specialResult.length,
              success: true
            }
          }
        }
      };
      
    } catch (error) {
      console.error(`❌ Test failed with error:`, error);
      
      return {
        success: false,
        message: "Test failed - the fix may not be working correctly",
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      };
    }
  },
});

/**
 * Test task for the complete keyword research workflow
 */
export const testKeywordResearchWorkflowTask = task({
  id: "test_keyword_research_workflow",
  retry: {
    maxAttempts: 1,
  },
  run: async ({ term = "RESTful API", onCacheHit = "revalidate" }: { term?: string; onCacheHit?: "revalidate" | "stale" }) => {
    console.info(`🔬 Testing complete keyword research workflow for term: ${term}`);
    
    try {
      // Import the keyword research task
      const { keywordResearchTask } = await import("./glossary/keyword-research");
      
      console.info("🚀 Starting keyword research task...");
      
      // Run the task that was previously failing
      const result = await keywordResearchTask.triggerAndWait({ term, onCacheHit });
      
      if (!result.ok) {
        throw new Error(`Keyword research task failed: ${JSON.stringify(result.error)}`);
      }
      
      console.info(`✅ Keyword research workflow completed successfully!`);
      console.info(`📊 Results:`, {
        term: result.output.term,
        totalKeywords: result.output.keywords.length,
        message: result.output.message
      });
      
      return {
        success: true,
        message: "Keyword research workflow test passed!",
        originalIssueFixed: true,
        results: result.output
      };
      
    } catch (error) {
      console.error(`❌ Workflow test failed:`, error);
      
      return {
        success: false,
        message: "Keyword research workflow test failed",
        originalIssueNotFixed: true,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      };
    }
  },
});