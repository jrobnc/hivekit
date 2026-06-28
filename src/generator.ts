import { readFile, mkdir, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { runAgent, fillTemplate, loadPrinciples } from "./sdk-utils.js";
import type {
  RunContext,
  GeneratorOutput,
  DimensionFindings,
} from "./types.js";
import { REVIEW_DIMENSIONS } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = join(__dirname, "..");

const DIMENSION_DESCRIPTIONS: Record<string, string> = {
  architecture:
    "Module boundaries, design patterns, dependency management. Look for circular dependencies, god objects, leaky abstractions.",
  bugs:
    "Logic errors, null safety, race conditions, off-by-one, unhandled edge cases, memory leaks, retain cycles.",
  security:
    "OWASP top 10, injection vulnerabilities, auth/authz gaps, data exposure, insecure storage, hardcoded secrets.",
  performance:
    "N+1 queries, unnecessary re-renders, expensive computations in hot paths, memory allocation, caching opportunities.",
  ux:
    "Accessibility, responsive design, error states, loading states, empty states, user-facing string quality.",
  platform:
    "Platform-specific: Swift concurrency, @MainActor, SwiftUI lifecycle, Core Data threads (iOS). SSR/CSR, hydration, bundle size (web).",
  consistency:
    "Cross-module naming conventions, error handling patterns, logging practices, API contracts, code style uniformity.",
};

// ── Review mode: parallel agents per dimension ──────────────────────

async function runReviewGenerators(
  ctx: RunContext,
  template: string
): Promise<DimensionFindings[]> {
  const { config, runId, runDir } = ctx;
  const planPath = join(runDir, "plan.md");
  const findingsDir = join(runDir, "findings");
  await mkdir(findingsDir, { recursive: true });

  const dimensions = REVIEW_DIMENSIONS[config.depth];
  const principles = await loadPrinciples();
  console.log(
    `[generator] Launching ${dimensions.length} review agents in parallel...`
  );

  const tasks = dimensions.map(async (dim) => {
    const findingsPath = join(findingsDir, `${dim}.json`);
    const prompt = fillTemplate(template, {
      dimension: dim,
      dimensionDescription: DIMENSION_DESCRIPTIONS[dim] ?? dim,
      dimensionFocus: `Focus on ${dim} aspects of the codebase.`,
      planPath,
      findingsPath,
      agentName: `Agent: ${dim}`,
      runId,
      principles,
    });

    console.log(`  [${dim}] started`);

    try {
      await runAgent({
        prompt,
        model: "sonnet",
        cwd: config.cwd,
        allowedTools: ["Read", "Glob", "Grep", "Bash", "Write"],
        permissionMode: "acceptEdits",
        maxTurns: config.maxTurns ?? 40,
      });
      console.log(`  [${dim}] complete`);
    } catch (err) {
      console.error(
        `  [${dim}] ERROR: ${err instanceof Error ? err.message : err}`
      );
    }

    // Read the findings file the agent wrote
    try {
      const raw = await readFile(findingsPath, "utf-8");
      return JSON.parse(raw) as DimensionFindings;
    } catch {
      return {
        dimension: dim,
        agent: `Agent: ${dim}`,
        runId,
        findings: [],
      } as DimensionFindings;
    }
  });

  return Promise.all(tasks);
}

// ── Build mode: single long-running agent ───────────────────────────

async function runBuildGenerator(
  ctx: RunContext,
  template: string
): Promise<void> {
  const { config, runDir } = ctx;
  const planPath = join(runDir, "plan.md");
  const progressPath = join(runDir, "progress.md");

  let prompt = fillTemplate(template, {
    planPath,
    progressPath,
    harnessRoot: HARNESS_ROOT,
    principles: await loadPrinciples(),
  });

  // Scope to a specific sprint if requested
  if (config.sprint) {
    prompt = `IMPORTANT: Only implement **Sprint ${config.sprint}** from the plan. Do NOT work on other sprints. Read the plan, find Sprint ${config.sprint}, and implement only that sprint's tasks.\n\n${prompt}`;
    console.log(`[generator] Starting build agent (Sprint ${config.sprint} only)...`);
  } else {
    console.log("[generator] Starting build agent...");
  }

  const { durationMs } = await runAgent({
    prompt,
    model: "opus",
    cwd: config.cwd,
    allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
    permissionMode: "acceptEdits",
    maxTurns: config.maxTurns ?? 100,
    onProgress: () => process.stdout.write("."),
  });

  console.log(`\n[generator] Build complete (${Math.round(durationMs / 1000)}s)`);
}

// ── Improve mode: 1-3 parallel agents ───────────────────────────────

async function runImproveGenerators(
  ctx: RunContext,
  template: string
): Promise<void> {
  const { config, runDir } = ctx;
  const planPath = join(runDir, "plan.md");
  const planContent = await readFile(planPath, "utf-8");

  // Split plan into sections for parallel agents
  const sections = planContent
    .split(/^###?\s+/m)
    .filter((s) => s.trim().length > 0);

  const agentCount = Math.min(3, Math.max(1, Math.ceil(sections.length / 4)));
  const principles = await loadPrinciples();
  console.log(`[generator] Launching ${agentCount} improvement agent(s)...`);

  // Round-robin assignment
  const assignments: string[][] = Array.from({ length: agentCount }, () => []);
  sections.forEach((section, i) => {
    assignments[i % agentCount].push(section.trim());
  });

  const tasks = assignments.map(async (assigned, i) => {
    const progressPath = join(runDir, `progress-${i + 1}.md`);
    const assignment = `You are improvement agent ${i + 1} of ${agentCount}. Your assigned improvements:\n\n${assigned.join("\n\n---\n\n")}`;

    const prompt = fillTemplate(template, {
      assignment,
      planPath,
      progressPath,
      harnessRoot: HARNESS_ROOT,
      principles,
    });

    console.log(`  [improve-${i + 1}] started`);

    try {
      await runAgent({
        prompt,
        model: "opus",
        cwd: config.cwd,
        allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
        permissionMode: "acceptEdits",
        maxTurns: config.maxTurns ?? 60,
      });
      console.log(`  [improve-${i + 1}] complete`);
    } catch (err) {
      console.error(
        `  [improve-${i + 1}] ERROR: ${err instanceof Error ? err.message : err}`
      );
    }
  });

  await Promise.all(tasks);

  // Merge individual progress files
  const merged: string[] = [];
  for (let i = 0; i < agentCount; i++) {
    try {
      const content = await readFile(join(runDir, `progress-${i + 1}.md`), "utf-8");
      merged.push(`# Agent ${i + 1}\n\n${content}`);
    } catch {
      merged.push(`# Agent ${i + 1}\n\n_No progress recorded._`);
    }
  }
  await writeFile(join(runDir, "progress.md"), merged.join("\n\n---\n\n"), "utf-8");

  console.log("[generator] All improvement agents complete");
}

// ── Entry point ─────────────────────────────────────────────────────

export async function runGenerator(
  ctx: RunContext,
  evaluatorFeedback?: string
): Promise<GeneratorOutput> {
  const { config } = ctx;

  let template = await readFile(
    join(__dirname, "prompts", `generator-${config.mode}.md`),
    "utf-8"
  );

  if (evaluatorFeedback) {
    template = `## Previous Evaluation Feedback\n\nThe evaluator found issues. Address these:\n\n${evaluatorFeedback}\n\n---\n\n${template}`;
  }

  switch (config.mode) {
    case "review": {
      const findings = await runReviewGenerators(ctx, template);
      return { mode: "review", findings };
    }
    case "build": {
      await runBuildGenerator(ctx, template);
      return { mode: "build", progressPath: join(ctx.runDir, "progress.md") };
    }
    case "improve": {
      await runImproveGenerators(ctx, template);
      return { mode: "improve", progressPath: join(ctx.runDir, "progress.md") };
    }
  }
}
