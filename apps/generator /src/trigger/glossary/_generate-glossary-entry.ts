import { db } from "@/lib/db-marketing/client";
import { entries } from "@/lib/db-marketing/schemas";
import { task } from "@trigger.dev/sdk/v3";
import { AbortTaskRunError } from "@trigger.dev/sdk/v3";
import { eq } from "drizzle-orm";
import { contentTakeawaysTask } from "./content-takeaways";
import { createPrTask } from "./create-pr";
import { draftSectionsTask } from "./draft-sections";
import { generateFaqsTask } from "./generate-faqs";
import { generateOutlineTask } from "./generate-outline";
import { keywordResearchTask } from "./keyword-research";
import { technicalResearchTask } from "./research/technical/_technical-research";
import { seoMetaTagsTask } from "./seo-meta-tags";

export type CacheStrategy = "revalidate" | "stale";
/**
 * This task generates a glossary entry for a given term. It's the main entry point of the glossary generation process.
 *
 * NB: I prefixed the filename with `_` to pin it to the top of the folder as trigger doesn't have any file-conventions.
 *
 * This workflow runs multiple steps sequentially:
 * 1. Keyword Research
 * 2. Technical Research
 * 3. Generate Outline
 * 4. Draft Sections & Content Takeaways (in parallel)
 * 5. Generate SEO Meta Tags
 * 6. Generate FAQs
 * 7. Create PR
 *
 * Each workflow step generates output that's stored in the database (with the exception of create PR, which stores the MDX output in the GitHub repository).
 * The default behaviour of every task is to always return a cached output if available.
 * This behaviour can be overridden by setting the `onCacheHit` parameter to `revalidate` (it'll get passed down to all tasks).
 *
 * Sub-tasks may (in fact most of them do) rely on undeterministic execution when they use LLMs. As a result, the maxAttempts for a subtask is 5.
 * The downside here is that this increases the runtime of the workflow considerably. Ways to mititage this are cited in the `todo` comment inside @file ./generate-outline.ts.
 *
 * The workflow is idempotent. If it's aborted, it can be safely restarted to allow for event replays in the trigger console.
 */
export const generateGlossaryEntryTask = task({
  id: "generate_glossary_entry",
  retry: {
    maxAttempts: 0,
  },
  run: async ({
    term,
    onCacheHit = "stale" as CacheStrategy,
  }: { term: string; onCacheHit?: CacheStrategy }) => {
    console.info(`-- Starting glossary entry generation for term: ${term} --`);

    const existing = await db.query.entries.findFirst({
      where: eq(entries.inputTerm, term),
      columns: {
        id: true,
        inputTerm: true,
        dynamicSectionsContent: true,
        metaTitle: true,
        metaDescription: true,
        githubPrUrl: true,
      },
      orderBy: (entries, { desc }) => [desc(entries.createdAt)],
    });

    if (
      existing?.dynamicSectionsContent &&
      existing?.metaTitle &&
      existing?.metaDescription &&
      existing?.githubPrUrl &&
      onCacheHit === "stale"
    ) {
      return {
        term,
        entry: existing,
      };
    }

    if (!existing) {
      // create the entry in the database if it doesn't exist, so that all other tasks can rely on it existing:
      await db.insert(entries).values({ inputTerm: term });
    }

    // Step 1: Keyword Research
    console.info("Step 1 - Starting keyword research...");
    const keywordResearch = await keywordResearchTask.triggerAndWait({ term, onCacheHit });
    if (!keywordResearch.ok) {
      throw new AbortTaskRunError(`Keyword research failed for term: ${term}`);
    }
    console.info(
      `✓ Keyword research completed with ${keywordResearch.output.keywords.length} keywords`,
    );

    // Step 1.5: Technical Research
    console.info("Step 1.5 - Starting technical research...");
    const technicalResearch = await technicalResearchTask.triggerAndWait({
      inputTerm: term,
      onCacheHit,
    });
    if (!technicalResearch.ok) {
      throw new AbortTaskRunError(`Technical research failed for term: ${term}`);
    }

    console.info("✓ Technical research completed and persisted");

    // Step 2: Generate Outline
    console.info("Step 2 - Generating outline...");
    const outline = await generateOutlineTask.triggerAndWait({ term, onCacheHit });
    if (!outline.ok) {
      throw new AbortTaskRunError(`Outline generation failed for term: ${term}`);
    }
    console.info("✓ Outline generated");

    // Step 3: Draft Sections & Content Takeaways (in parallel)
    console.info("Step 3 - Drafting sections...");
    const draftSections = await draftSectionsTask.triggerAndWait({ term, onCacheHit });
    if (!draftSections.ok) {
      throw new AbortTaskRunError(`Section drafting failed for term: ${term}`);
    }
    console.info("✓ Sections drafted");

    console.info("Step 4 - Generating takeaways...");
    const contentTakeaways = await contentTakeawaysTask.triggerAndWait({ term, onCacheHit });
    if (!contentTakeaways.ok) {
      throw new AbortTaskRunError(`Content takeaways generation failed for term: ${term}`);
    }
    console.info("✓ Takeaways generated");

    // Step 5: Generate SEO Meta Tags
    console.info("Step 5 - Generating SEO meta tags...");
    const seoMetaTags = await seoMetaTagsTask.triggerAndWait({ term, onCacheHit });
    if (!seoMetaTags.ok) {
      throw new AbortTaskRunError(`SEO meta tags generation failed for term: ${term}`);
    }
    console.info("✓ SEO meta tags generated");

    // Step 6: Generate FAQs
    console.info("Step 6 - Generating FAQs...");
    const faqs = await generateFaqsTask.triggerAndWait({ term, onCacheHit });
    if (!faqs.ok) {
      throw new AbortTaskRunError(`FAQ generation failed for term: ${term}`);
    }
    console.info("✓ FAQs generated");

    // Step 7: Create PR
    console.info("Step 7 - Creating PR...");
    const pr = await createPrTask.triggerAndWait({ input: term, onCacheHit });
    if (!pr.ok) {
      throw new AbortTaskRunError(`PR creation failed for term: ${term}`);
    }

    if (!pr.output.entry?.id) {
      // this if statement is here to make TypeScript happy
      throw new AbortTaskRunError(`PR creation failed for term: ${term}`);
    }
    console.info(`✓ PR created: ${pr.output.entry?.githubPrUrl}`);

    const generated = await db.query.entries.findFirst({
      where: eq(entries.id, pr.output.entry?.id),
      orderBy: (entries, { desc }) => [desc(entries.createdAt)],
    });

    return {
      term,
      keywordCount: keywordResearch.output.keywords.length,
      sectionCount: outline?.output?.dynamicSections.length,
      seoMetaTags: seoMetaTags.output,
      entry: generated,
    };
  },
});
