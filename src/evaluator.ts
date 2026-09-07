import { readFile, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { runAgent, fillTemplate, loadPrinciples } from "./sdk-utils.js";
import { formatCriteriaForEvaluator } from "./intent.js";
import type { RunContext, EvaluationResult, Mode, CriterionScore } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));



/** What a complete verdict must contain, per mode. */
export interface CriteriaPolicy {
  /** Exact criteria the mode's prompt defines, or null when reviewer-chosen. */
  expected: string[] | null;
  /** Minimum distinct criteria when `expected` is null. */
  minCriteria: number;
}

/**
 * Criteria each mode's evaluator prompt actually specifies.
 *
 * Checking the SET, not a count, is what makes the gate a completeness check:
 * counting rows alone is satisfied by four fabricated criteria, by the same
 * criterion repeated five times, or by any incidental `xx/100`-shaped table.
 */
export const CRITERIA_POLICY: Record<Mode, CriteriaPolicy> = {
  build: {
    expected: ["feature completeness", "code quality", "design quality", "functionality", "restraint"],
    minCriteria: 5,
  },
  improve: {
    expected: ["completion", "quality", "safety", "restraint"],
    minCriteria: 4,
  },
  // Review criteria are chosen by the reviewer per codebase, so only a floor
  // can be enforced.
  review: { expected: null, minCriteria: 2 },
};

export function criteriaPolicyFor(mode: Mode): CriteriaPolicy {
  return CRITERIA_POLICY[mode];
}

/** Normalise a criterion name for comparison: strip markup, case and spacing. */
function normalizeCriterion(name: string): string {
  return name
    .replace(/[*_`|]/g, "")
    // Leading status emoji an LLM decorates a row with: "✅ Completion".
    .replace(/^[^\p{L}\p{N}]+/u, "")
    // Trailing punctuation only. A trailing parenthetical is handled by
    // criterionAliases, NOT stripped here: erasing it collapsed two genuinely
    // distinct criteria ("Security (auth)" and "Security (crypto)") into one,
    // losing a score from the recorded scorecard.
    .replace(/[:.!\s]+$/, "")
    .normalize("NFKC")
    .replace(/\u00AD/g, "") // soft hyphen
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Classify evaluator output into a terminal verdict.
 *
 * Three independent signals must all agree before this returns `passed`:
 *   1. an explicit `EVALUATION: PASS` assertion,
 *   2. a complete scorecard — every criterion the mode defines, no duplicates
 *      disagreeing with each other, all values in 0-100,
 *   3. every score at or above the threshold.
 *
 * Requiring (1) is what stops a pass being INFERRED from the mere absence of a
 * FAIL marker. That inference was the hole behind the quoted-scorecard attack:
 * the evaluator has Read/Grep over the target repo, where old
 * `.claude/harness/*​/report.md` files hold filled passing tables, so an
 * evaluator that says "I could not verify this; the previous run scored:" and
 * quotes one used to be read as asserting those scores itself. Quoting a table
 * asserts nothing; only `EVALUATION: PASS` does.
 *
 * Every ambiguous branch fails closed, and `failed` (judged and rejected) stays
 * distinct from `errored` (no usable judgement).
 */
export function parseEvaluation(
  text: string,
  threshold: number,
  policy: CriteriaPolicy
): EvaluationResult {
  const fail = (
    status: EvaluationResult["status"],
    reason: EvaluationResult["reason"],
    scores: EvaluationResult["scores"],
    feedback: string
  ): EvaluationResult => ({ scores, status, reason, passed: false, feedback, report: text });

  // Fail closed: empty output means the evaluator crashed or timed out.
  if (!text.trim()) {
    return {
      scores: [], status: "errored", reason: "empty_output", passed: false,
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
    if (criterion.startsWith("-")) continue;
    scores.push({ criterion, score: parseInt(match[2], 10), assessment: match[3].trim() });
  }

  // Also check for "- CriterionName: xx/100" format
  const listPattern = /^[-*]\s*(.+?):\s*(\d+)\/100/gm;
  while ((match = listPattern.exec(text)) !== null) {
    const criterion = match[1].trim();
    // "**Weighted Average**: xx/100" summarises the other rows; the leading "*"
    // of the bold marker makes it match the list pattern. Counting it would
    // double-weight the aggregate.
    if (isAggregateLabel(criterion)) continue;
    scores.push({ criterion, score: parseInt(match![2], 10), assessment: "" });
  }

  // Fail CLOSED: match the FAIL marker case-insensitively with flexible spacing
  // and the FAIL/FAILED variants. An exact "EVALUATION: FAIL" .includes() check
  // silently PASSED near-misses ("EVALUATION:  FAILED").
  //
  // Checked BEFORE the score branches: an explicit rejection is a decisive
  // `failed` even with no scorecard, never an ambiguous `errored`.
  if (/EVALUATION:\s*FAIL/i.test(text)) {
    return fail("failed", "explicit_fail_marker", scores, text);
  }

  // Collapse duplicates, keeping the LOWEST score for each criterion.
  //
  // Fail closed on the VALUE rather than on the classification. Rejecting any
  // disagreement outright was weaponizable in both directions: a transcription
  // typo (95 vs 96) failed a genuinely good build, and a real rejection restated
  // with a rounding difference was downgraded from `failed` to `errored` —
  // destroying the "judged and rejected" vs "never verified" distinction. The
  // prompts make disagreement likely rather than exotic, since the report
  // template is a table and the required response block is a list, so an
  // evaluator that includes both states every score twice.
  //
  // Taking the minimum also handles the adversarial case directly: a low
  // scorecard followed by a high "summary" one scores as the low one.
  const byName = new Map<string, CriterionScore>();
  for (const s of scores) {
    const key = normalizeCriterion(s.criterion);
    const seen = byName.get(key);
    if (!seen || s.score < seen.score) byName.set(key, s);
  }
  const unique = [...byName.values()];

  if (unique.length === 0) {
    return fail(
      "errored", "no_parseable_scores", [],
      "Evaluator produced output but no parseable scores — failing closed. Ensure the evaluator emits a scorecard table (| Criterion | xx/100 | Assessment |)."
    );
  }

  // Fail closed on impossible scores. "150/100" would otherwise clear any
  // threshold, letting a malformed or adversarial scorecard buy a pass.
  const malformed = unique.filter((s) => !Number.isFinite(s.score) || s.score < 0 || s.score > 100);
  if (malformed.length > 0) {
    return fail(
      "errored", "malformed_scores", unique,
      `Evaluator emitted out-of-range scores (${malformed.map((s) => `${s.criterion}: ${s.score}`).join(", ")}) — failing closed. Scores must be 0-100.`
    );
  }

  // A scorecard must be COMPLETE, not merely present.
  if (policy.expected) {
    const present = new Set(unique.flatMap((s) => criterionAliases(s.criterion)));
    const missing = policy.expected.filter((c) => !present.has(c));
    if (missing.length > 0) {
      return fail(
        "errored", "missing_criteria", unique,
        `Evaluator scorecard is missing required criteria (${missing.join(", ")}) — failing closed. A partial scorecard is not a verdict.`
      );
    }
  } else if (unique.filter((s) => isNamedCriterion(s.criterion)).length < policy.minCriteria) {
    // Named-criterion guard: "| . | 95/100 |" twice otherwise satisfies a floor
    // of 2. Two characters with at least one letter keeps real short names
    // ("UX", "QA") while rejecting punctuation placeholders.
    return fail(
      "errored", "insufficient_criteria", unique,
      `Evaluator emitted only ${unique.length} named criterion/criteria; at least ${policy.minCriteria} are required — failing closed. The scorecard was likely truncated.`
    );
  }

  if (!unique.every((s) => s.score >= threshold)) {
    return fail("failed", "below_threshold", unique, text);
  }

  // A pass must be ASSERTED, never inferred from the absence of a rejection —
  // and the assertion must be STRUCTURAL, not a substring anywhere in the text.
  //
  // The evaluator prompt necessarily contains the literal string
  // `EVALUATION: PASS` (it has to say what to emit), so a plain
  // `.test(text)` is a credential the prompt hands out for free: an evaluator
  // that says "I cannot honestly produce the required `EVALUATION: PASS` line"
  // matched it and was recorded as verified.
  //
  // Note the deliberate asymmetry with the FAIL check above, which stays
  // unanchored: be liberal about what counts as a rejection, strict about what
  // counts as an acceptance. Both biases point the same way — toward failing.
  if (!hasPassAssertion(text)) {
    return fail(
      "errored", "no_pass_assertion", unique,
      "Evaluator scores clear the threshold but the response does not BEGIN with `EVALUATION: PASS` — failing closed. The verdict must be the first line of the response; quoting or restating the requirement is not an acceptance."
    );
  }

  return {
    scores: unique,
    status: "passed",
    reason: "all_scores_above_threshold",
    passed: true,
    feedback: undefined,
    report: text,
  };
}

/**
 * True when the response makes its OWN acceptance assertion.
 *
 * Required shape: `EVALUATION: PASS` as the FIRST non-blank line of the
 * response. Not "somewhere in the text", not "at column 0 somewhere" — first.
 *
 * Every weaker rule fell to a quoting idiom, because the evaluator prompt must
 * itself contain the string `EVALUATION: PASS` in order to ask for it:
 *   - a substring test passed on "I cannot produce the required
 *     `EVALUATION: PASS` line";
 *   - a column-0 + not-inside-a-fence test passed on a quoted block whose own
 *     content held a nested ``` marker, which inverted the fence-state toggle;
 *     and the same toggle silently BLANKED a legitimate assertion whenever an
 *     unbalanced fence marker (a quoted diff, a log line) appeared earlier.
 *
 * Position is the one property a quotation cannot forge: a response that is
 * explaining, hedging or declining cannot have the verdict as its opening line,
 * and a response whose opening line IS the verdict is asserting it under any
 * reading. No markdown parsing, so nothing to spoof and nothing to unbalance.
 *
 * The FAIL check stays unanchored and matches anywhere: be liberal about what
 * counts as a rejection, strict about what counts as an acceptance.
 */
export function hasPassAssertion(text: string): boolean {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0);
  return firstLine !== undefined && /^EVALUATION:[^\S\r\n]*PASS(?:ED)?\b/i.test(firstLine);
}

/** Negative qualifiers that must NOT be aliased away — they are the evaluator flagging partial work. */
const DISCLAIMING_QUALIFIER = /\b(not|no|un|skip|skipped|unverified|partial|todo|fail|failed|pending|assumed)\b/i;

/**
 * Names a criterion may match against a required name.
 *
 * "Completion (scope)" should satisfy a required "completion"; "Completion (NOT
 * VERIFIED)" must not — that parenthetical is the evaluator telling us it did
 * not do the work, and silently erasing it turns a disclaimer into a pass.
 */
function criterionAliases(criterion: string): string[] {
  const full = normalizeCriterion(criterion);
  const aliases = [full];
  const m = full.match(/^(.*?)\s*\(([^)]*)\)$/);
  if (m && m[1] && !DISCLAIMING_QUALIFIER.test(m[2])) aliases.push(m[1].trim());
  return aliases;
}

/** A real criterion name: at least two characters, at least one of them a letter. */
function isNamedCriterion(criterion: string): boolean {
  const n = normalizeCriterion(criterion);
  return n.length >= 2 && /\p{L}/u.test(n);
}

/** True for scorecard rows that summarise other rows rather than being criteria. */
function isAggregateLabel(criterion: string): boolean {
  const normalized = normalizeCriterion(criterion);
  return ["weighted average", "average", "overall", "total"].includes(normalized);
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

  const evaluation = parseEvaluation(
    resultText,
    config.evalThreshold,
    criteriaPolicyFor(config.mode)
  );

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
