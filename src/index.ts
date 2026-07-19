#!/usr/bin/env node

// Billing guard lives in bin/harness (a shell wrapper that strips
// ANTHROPIC_API_KEY before Node starts). Doing it here is too late —
// ESM imports are hoisted and their top-level code runs before any
// statement in this file, so the SDK can already have read the env var.

import { mkdir, readFile, appendFile, writeFile, copyFile } from "fs/promises";
import { join, resolve } from "path";
import { runPlanner } from "./planner.js";
import { runGenerator } from "./generator.js";
import { runEvaluator } from "./evaluator.js";
import { loadIntent, intentCompilePreamble, toIntentYaml } from "./intent.js";
import type { HarnessConfig, Mode, Depth, RunContext, IntentDoc } from "./types.js";

// ── Argument parsing ────────────────────────────────────────────────

function parseArgs(argv: string[]): HarnessConfig {
  const args = argv.slice(2);
  let mode: Mode = "review";
  let depth: Depth = "standard";
  let focus: string | undefined;
  let name: string | undefined;
  let cwd = process.cwd();
  let sprint: number | undefined;
  let planFile: string | undefined;
  let intentFile: string | undefined;
  let emitYaml = false;
  let maxTurns: number | undefined;
  const taskParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const nextArg = (flag: string): string => {
      if (i + 1 >= args.length) {
        console.error(`Error: ${flag} requires a value`);
        process.exit(1);
      }
      return args[++i];
    };

    switch (args[i]) {
      case "--mode":
        mode = nextArg("--mode") as Mode;
        break;
      case "--depth":
        depth = nextArg("--depth") as Depth;
        break;
      case "--focus":
        focus = nextArg("--focus");
        break;
      case "--name":
        name = nextArg("--name");
        break;
      case "--cwd":
        cwd = resolve(nextArg("--cwd"));
        break;
      case "--sprint": {
        sprint = parseInt(nextArg("--sprint"), 10);
        if (isNaN(sprint)) {
          console.error("Error: --sprint requires a numeric value");
          process.exit(1);
        }
        break;
      }
      case "--plan":
        planFile = resolve(nextArg("--plan"));
        break;
      case "--intent":
        intentFile = resolve(nextArg("--intent"));
        break;
      case "--yaml":
        emitYaml = true;
        break;
      case "--max-turns": {
        maxTurns = parseInt(nextArg("--max-turns"), 10);
        if (isNaN(maxTurns)) {
          console.error("Error: --max-turns requires a numeric value");
          process.exit(1);
        }
        break;
      }
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      default:
        if (args[i].startsWith("--")) {
          console.error(`Error: unknown flag ${args[i]}`);
          process.exit(1);
        }
        taskParts.push(args[i]);
    }
  }

  const task = taskParts.join(" ");
  // No hard "task required" check here: a run may be driven by --intent or an
  // auto-discovered HIVE.md instead of a task string. resolveIntent() does the
  // final check once the filesystem has been consulted.

  // Infer mode from task if not explicitly set
  const explicitMode = args.includes("--mode");
  if (!explicitMode) {
    if (/\b(review|audit|evaluate|assess|check)\b/i.test(task)) {
      mode = "review";
    } else if (/\b(build|create|add|implement)\b/i.test(task)) {
      mode = "build";
    } else if (/\b(improve|refactor|fix|optimize|upgrade)\b/i.test(task)) {
      mode = "improve";
    }
  }

  return {
    task,
    mode,
    depth,
    focus,
    name,
    cwd,
    maxEvalRounds: 3,
    evalThreshold: 60,
    sprint,
    planFile,
    intentFile,
    emitYaml,
    maxTurns,
    explicitMode,
  };
}

/**
 * Resolve the intent source for a run: explicit --intent, else an auto-discovered
 * HIVE.md / intent.md in the cwd when no task was given. Mutates config (task,
 * intentFile, mode, name) and returns the parsed IntentDoc, or undefined for a
 * plain task run. Exits if there is neither a task nor an intent file.
 */
async function resolveIntent(config: HarnessConfig): Promise<IntentDoc | undefined> {
  let intentPath = config.intentFile;

  if (!intentPath && !config.task) {
    for (const name of ["HIVE.md", "intent.md"]) {
      const candidate = join(config.cwd, name);
      try {
        await readFile(candidate, "utf-8");
        intentPath = candidate;
        break;
      } catch {
        // not present — keep looking
      }
    }
  }

  if (!intentPath) {
    if (!config.task) {
      console.error(
        "Error: provide a task, --intent <file>, or a HIVE.md / intent.md in --cwd"
      );
      printUsage();
      process.exit(1);
    }
    return undefined;
  }

  let intent: IntentDoc;
  try {
    intent = await loadIntent(intentPath);
  } catch {
    console.error(`Error: could not read intent file ${intentPath}`);
    process.exit(1);
  }

  config.intentFile = intentPath;
  config.task = intentCompilePreamble(intent);
  if (!config.explicitMode) config.mode = "build"; // compiling an intent is a build by default
  config.name ??= "hive"; // keep run ids readable (task is now a long preamble)
  console.log(
    `[intent] Driving run from ${intentPath} — ${intent.successCriteria.length} success criteria`
  );
  return intent;
}

function printUsage() {
  console.log(`
Usage: hivekit <task> [options]

Options:
  --mode <review|build|improve>   Run mode (default: inferred from task)
  --depth <quick|standard|deep>   Agent thoroughness (default: standard)
  --focus <area>                   Focus area (e.g., ios, auth, api)
  --name <name>                    Human-readable run name
  --cwd <path>                     Working directory (default: current)
  --sprint <N>                     Scope build to sprint N from the plan
  --plan <path>                    Reuse an existing plan file (skip planner)
  --intent <path>                  Drive the run from a HIVE.md / intent.md (intent-as-source)
  --yaml                           Also emit a structured intent.yaml alongside the markdown (opt-in)
  --max-turns <N>                  Max turns per agent (default: 100 build, 60 improve, 40 review)
  -h, --help                       Show this help

Examples:
  hivekit "review the iOS app" --depth deep
  hivekit "build user authentication" --mode build
  hivekit "fix the 25 bugs from the last review" --mode improve --focus games

  # Drive a build from a HIVE.md intent file (or drop one in --cwd and omit the task):
  hivekit --intent HIVE.md --cwd ~/dev/my-app
  hivekit --cwd ~/dev/my-app   # auto-discovers HIVE.md / intent.md

  # Run a specific sprint from an existing plan:
  hivekit "build sprint 3" --mode build --sprint 3 --plan .claude/harness/prev-run/plan.md
`);
}

// ── Run management ──────────────────────────────────────────────────

function generateRunId(config: HarnessConfig): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const slug =
    config.name ??
    config.focus ??
    config.task
      .split(/\s+/)
      .slice(0, 2)
      .join("")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  return `${config.mode}-${slug}-${timestamp}`;
}

async function initRun(config: HarnessConfig): Promise<RunContext> {
  const runId = generateRunId(config);
  const runDir = join(config.cwd, ".claude", "harness", runId);
  const indexPath = join(config.cwd, ".claude", "harness", "index.md");

  await mkdir(runDir, { recursive: true });

  // Ensure index file exists with header
  try {
    await readFile(indexPath, "utf-8");
  } catch {
    await mkdir(join(config.cwd, ".claude", "harness"), { recursive: true });
    await writeFile(
      indexPath,
      "| Run ID | Mode | Status | Timestamp | Summary |\n|--------|------|--------|-----------|----------|\n",
      "utf-8"
    );
  }

  return { runId, runDir, indexPath, config };
}

async function updateIndex(
  ctx: RunContext,
  status: string,
  summary: string
) {
  const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const line = `| ${ctx.runId} | ${ctx.config.mode} | ${status} | ${timestamp} | ${summary} |\n`;
  await appendFile(ctx.indexPath, line, "utf-8");
}

// ── Main orchestrator ───────────────────────────────────────────────

async function main() {
  const config = parseArgs(process.argv);
  const intent = await resolveIntent(config);

  console.log(`
┌─────────────────────────────────────────────┐
│           HARNESS ORCHESTRATOR              │
├─────────────────────────────────────────────┤
│ Mode:   ${config.mode.padEnd(36)}│
│ Depth:  ${config.depth.padEnd(36)}│
│ Focus:  ${(config.focus ?? "all").padEnd(36)}│
│ Sprint: ${(config.sprint?.toString() ?? "all").padEnd(36)}│
│ Plan:   ${(config.planFile ? "reusing" : "generate").padEnd(36)}│
│ CWD:    ${(config.cwd.length > 35 ? ("…" + config.cwd.slice(-34)).padEnd(36) : config.cwd.padEnd(36))}│
└─────────────────────────────────────────────┘
`);

  const ctx = await initRun(config);
  ctx.intent = intent;
  console.log(`Run ID: ${ctx.runId}`);
  console.log(`Artifacts: ${ctx.runDir}/\n`);

  // Opt-in structured view: emit the compiled intent as YAML for downstream tooling.
  // Markdown stays the source of truth; this is an additional machine-readable artifact.
  if (config.emitYaml) {
    if (intent) {
      const yamlPath = join(ctx.runDir, "intent.yaml");
      await writeFile(yamlPath, toIntentYaml(intent), "utf-8");
      console.log(`[intent] structured YAML written: ${yamlPath}\n`);
    } else {
      console.log("[intent] --yaml ignored: no HIVE.md / intent.md drives this run\n");
    }
  }

  try {
    // ── Phase 1: Planning ────────────────────────────────────────
    let plan: { planPath: string; planContent: string };

    if (config.planFile) {
      // Reuse existing plan
      console.log("═══ Phase 1: Planner (reusing existing plan) ═══");
      const existingPlan = await readFile(config.planFile, "utf-8");
      const planPath = join(ctx.runDir, "plan.md");
      await copyFile(config.planFile, planPath);
      plan = { planPath, planContent: existingPlan };
      console.log(`Reused plan from ${config.planFile} (${plan.planContent.length} chars)\n`);
      await updateIndex(ctx, "planning", "Reused existing plan");
    } else {
      console.log("═══ Phase 1: Planner ═══");
      await updateIndex(ctx, "planning", "Planning...");
      plan = await runPlanner(ctx);
      console.log(`Plan: ${plan.planContent.length} chars\n`);
    }

    // ── Phase 2 & 3: Generate → Evaluate loop ───────────────────
    let round = 0;
    let evaluatorFeedback: string | undefined;
    let lastEvaluation: { scores: Array<{ criterion: string; score: number }> } | undefined;

    while (round < config.maxEvalRounds) {
      round++;

      // ── Phase 2: Generate ──────────────────────────────────────
      console.log(`\n═══ Phase 2: Generator (round ${round}) ═══`);
      await updateIndex(ctx, `generating-r${round}`, `Generator round ${round}`);
      const genOutput = await runGenerator(ctx, evaluatorFeedback);

      // ── Phase 3: Evaluate ──────────────────────────────────────
      console.log(`\n═══ Phase 3: Evaluator (round ${round}) ═══`);
      await updateIndex(ctx, `evaluating-r${round}`, `Evaluator round ${round}`);
      const evaluation = await runEvaluator(ctx, round);
      lastEvaluation = evaluation;

      if (evaluation.passed) {
        await updateIndex(ctx, "complete", summarizeScores(evaluation));
        console.log("\n┌─────────────────────────────────────────────┐");
        console.log("│              HARNESS COMPLETE                │");
        console.log("└─────────────────────────────────────────────┘");
        console.log(`Report: ${join(ctx.runDir, "report.md")}`);

        printScorecard(evaluation.scores);
        return;
      }

      // For review mode, don't re-run — reviews are one-shot
      if (config.mode === "review") {
        const status = evaluation.passed ? "complete" : "complete-review-failed";
        await updateIndex(ctx, status, summarizeScores(evaluation));
        printScorecard(evaluation.scores);
        console.log(`\nReview mode — evaluator output is the final report.`);
        console.log(`Report: ${join(ctx.runDir, "report.md")}`);
        return;
      }

      // Not passed — loop back to generator with feedback
      const MAX_FEEDBACK_CHARS = 4000;
      evaluatorFeedback = evaluation.feedback && evaluation.feedback.length > MAX_FEEDBACK_CHARS
        ? evaluation.feedback.slice(0, MAX_FEEDBACK_CHARS) + "\n\n[…feedback truncated to 4000 chars]"
        : evaluation.feedback;
      console.log(
        `\nRe-running generator with evaluator feedback (round ${round + 1})...\n`
      );
    }

    // Max rounds exhausted
    await updateIndex(
      ctx,
      "complete-partial",
      `Max rounds (${config.maxEvalRounds}) reached`
    );
    console.log(
      `\nMax evaluation rounds (${config.maxEvalRounds}) reached. Check report for remaining issues.`
    );
    if (lastEvaluation) printScorecard(lastEvaluation.scores);
    console.log(`Report: ${join(ctx.runDir, "report.md")}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateIndex(ctx, "failed", msg.slice(0, 80));
    console.error(`\nHARNESS FAILED: ${msg}`);
    process.exit(1);
  }
}

function printScorecard(scores: Array<{ criterion: string; score: number }>) {
  if (scores.length === 0) return;
  console.log("\nScorecard:");
  for (const s of scores) {
    const bar = "█".repeat(Math.floor(s.score / 5));
    console.log(`  ${s.criterion.padEnd(25)} ${s.score}/100 ${bar}`);
  }
}

function summarizeScores(
  evaluation: { scores: Array<{ criterion: string; score: number }> }
): string {
  if (evaluation.scores.length === 0) return "Passed";
  const avg =
    evaluation.scores.reduce((sum, s) => sum + s.score, 0) /
    evaluation.scores.length;
  return `Avg ${Math.round(avg)}/100 — ${evaluation.scores.length} criteria`;
}

main();
