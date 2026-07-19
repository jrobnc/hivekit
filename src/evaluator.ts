import { readFile, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { runAgent, fillTemplate, loadPrinciples } from "./sdk-utils.js";
import { formatCriteriaForEvaluator } from "./intent.js";
import type { RunContext, EvaluationResult } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Parse evaluator output to determine pass/fail and extract scores */
export function parseEvaluation(text: string, threshold: number): EvaluationResult {
  // Fail closed: empty output means the evaluator crashed or timed out.
  if (!text.trim()) {
    return {
      scores: [],
      passed: false,
      feedback: "Evaluator returned empty output — treating as failure (fail-closed)",
      report: "",
    };
  }

  const scores: EvaluationResult["scores"] = [];

  // Extract from markdown table: | Criterion | xx/100 | Assessment |
  // Use [^\S\r\n] (space/tab, never newline) between cells: plain \s* matches
  // newlines, letting a row match start on a separator line's trailing "|" and
  // capture the next row's leading "|" into the criterion name ("| Code Quality").
  const tablePattern =
    /\|[^\S\r\n]*(.+?)[^\S\r\n]*\|[^\S\r\n]*(\d+)\/100[^\S\r\n]*\|[^\S\r\n]*(.+?)[^\S\r\n]*\|/g;
  let match: RegExpExecArray | null;
  while ((match = tablePattern.exec(text)) !== null) {
    const criterion = match[1].trim();
    if (criterion === "---" || criterion.startsWith("-")) continue;
    scores.push({
      criterion,
      score: parseInt(match[2], 10),
      assessment: match[3].trim(),
    });
  }

  // Also check for "- CriterionName: xx/100" format
  const listPattern = /^[-*]\s*(.+?):\s*(\d+)\/100/gm;
  while ((match = listPattern.exec(text)) !== null) {
    if (!scores.some((s) => s.criterion === match![1].trim())) {
      scores.push({
        criterion: match![1].trim(),
        score: parseInt(match![2], 10),
        assessment: "",
      });
    }
  }

  // Fail CLOSED: match the FAIL marker case-insensitively with flexible spacing
  // and the FAIL/FAILED variants. An exact "EVALUATION: FAIL" .includes() check
  // silently PASSED near-misses ("EVALUATION:  FAILED"), shipping broken code as
  // "verified" whenever the evaluator's return text had no parseable scorecard.
  const explicitFail = /EVALUATION:\s*FAIL/i.test(text);
  const allAboveThreshold =
    scores.length > 0 && scores.every((s) => s.score >= threshold);
  const passed = !explicitFail && (scores.length === 0 || allAboveThreshold);

  return {
    scores,
    passed,
    feedback: passed ? undefined : text,
    report: text,
  };
}

/** Runs the evaluator agent. Reads plan from {runDir}/plan.md and findings from {runDir}/findings/ on disk. */
export async function runEvaluator(
  ctx: RunContext,
  round: number
): Promise<EvaluationResult> {
  const { config, runId, runDir } = ctx;
  const planPath = join(runDir, "plan.md");
  const reportPath = join(runDir, "report.md");
  const progressPath = join(runDir, "progress.md");
  const findingsDir = join(runDir, "findings");

  const template = await readFile(
    join(__dirname, "prompts", `evaluator-${config.mode}.md`),
    "utf-8"
  );

  const prompt = fillTemplate(template, {
    planPath,
    reportPath,
    runId,
    depth: config.depth,
    round: round.toString(),
    maxRounds: config.maxEvalRounds.toString(),
    threshold: config.evalThreshold.toString(),
    findingsDir,
    progressPath,
    principles: await loadPrinciples(),
    successCriteria: formatCriteriaForEvaluator(ctx.intent),
  });

  console.log(
    `[evaluator] Starting evaluation (round ${round}/${config.maxEvalRounds})...`
  );

  const { result: resultText, durationMs } = await runAgent({
    prompt,
    model: "opus",
    cwd: config.cwd,
    allowedTools: ["Read", "Glob", "Grep", "Bash", "Write"],
    permissionMode: "acceptEdits",
    maxTurns: config.maxTurns ?? 40,
    onProgress: () => process.stdout.write("."),
  });

  console.log(`\n[evaluator] Done (${Math.round(durationMs / 1000)}s)`);

  const evaluation = parseEvaluation(resultText, config.evalThreshold);

  if (evaluation.passed) {
    // Ensure report was written to disk AND has content (agents sometimes
    // call Write with an empty string, leaving a 0-byte file that passes
    // a naive existence check).
    let needsFallback = false;
    try {
      const existing = await readFile(reportPath, "utf-8");
      needsFallback = existing.trim().length === 0;
    } catch {
      needsFallback = true;
    }
    if (needsFallback) {
      await writeFile(reportPath, resultText, "utf-8");
      console.log("[evaluator] PASSED — wrote report to", reportPath);
    } else {
      console.log("[evaluator] PASSED — report at", reportPath);
    }
  } else {
    console.log(`[evaluator] FAILED (round ${round})`);
    if (evaluation.scores.length > 0) {
      for (const s of evaluation.scores) {
        const icon = s.score >= config.evalThreshold ? "✓" : "✗";
        console.log(`  ${icon} ${s.criterion}: ${s.score}/100`);
      }
    }
  }

  return evaluation;
}
