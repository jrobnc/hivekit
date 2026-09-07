/**
 * The verification boundary.
 *
 * Every terminal state of a hivekit run funnels through this module: the exit
 * code, the machine-readable result.json and the human-facing report banner are
 * all derived from a single `RunOutcome`. Nothing else in the codebase is
 * allowed to decide "did this run succeed" — in particular, success is never
 * inferred from generator completion, from files appearing on disk, or from
 * prose written by a report-writing agent.
 *
 * Historical defect this module exists to prevent: the generate/evaluate loop
 * could exhaust its rounds with three consecutive FAILED verdicts, fall off the
 * end of main() with no exit code, and leave an agent-authored report.md
 * claiming "Result: PASS" as the only artifact a human would read.
 */

import type {
  EvaluationReason,
  EvaluationStatus,
  Mode,
  RunOutcome,
  RunResult,
  CriterionScore,
} from "./types.js";

/**
 * Process exit codes, one per terminal outcome.
 *
 * Distinct codes are a hard requirement: a caller must be able to tell an
 * evaluator rejection (2) from rounds running out (3) from an evaluator that
 * never produced a verdict (4) from hivekit itself crashing (1) — without
 * parsing stdout.
 */
export const EXIT_CODES: Record<RunOutcome, number> = {
  passed: 0,
  review_completed: 0,
  crashed: 1,
  failed: 2,
  max_rounds_exhausted: 3,
  errored: 4,
};

/** Outcomes that represent a genuinely verified success. */
const SUCCESS_OUTCOMES: ReadonlySet<RunOutcome> = new Set<RunOutcome>([
  "passed",
  "review_completed",
]);

export function isSuccessOutcome(outcome: RunOutcome): boolean {
  return SUCCESS_OUTCOMES.has(outcome);
}

export function exitCodeFor(outcome: RunOutcome): number {
  // Unknown outcome must never map to 0. Default to the crash code.
  return EXIT_CODES[outcome] ?? EXIT_CODES.crashed;
}

/**
 * Coarse verdict string for humans and grep-based callers.
 *
 * Deliberately never emits the bare token "PASS": agent-authored reports use
 * "Result: PASS", and a caller grepping for it must not be able to confuse the
 * two. hivekit's own success token is "PASSED".
 */
export function resultLabelFor(outcome: RunOutcome): string {
  switch (outcome) {
    case "passed":
      return "PASSED";
    case "review_completed":
      return "REVIEW_COMPLETED";
    default:
      return "FAILED";
  }
}

export interface OutcomeInput {
  mode: Mode;
  /**
   * Whether --mode was given explicitly on the command line.
   *
   * Load-bearing for safety: `mode` DEFAULTS to "review" and is also inferred
   * from task keywords ("check", "audit", "evaluate"...), with the review regex
   * tested first. Without this gate, `hivekit "implement payments and check the
   * tests"` would silently take review mode's exit-0 path and report success
   * over an evaluator FAIL — the very defect this module exists to prevent.
   */
  explicitMode?: boolean;
  /** Verdict of the final evaluator round, or undefined if none ever ran. */
  terminalStatus?: EvaluationStatus;
  /**
   * Whether ANY round produced a real verdict (passed/failed) rather than an
   * error. Separates "we judged the work and it kept failing" from "we never
   * managed to verify anything at all".
   */
  anyJudged?: boolean;
  roundsRun: number;
  maxRounds: number;
}

/**
 * Map the loop's terminal state to a RunOutcome. Pure — no I/O, no clock.
 *
 * Fail-closed by construction: every branch that is not an explicit,
 * evaluator-confirmed acceptance returns a non-success outcome.
 */
export function decideOutcome(input: OutcomeInput): RunOutcome {
  const { mode, explicitMode, terminalStatus, anyJudged, roundsRun, maxRounds } = input;

  // No evaluator verdict at all — we verified nothing. Never a success.
  if (terminalStatus === undefined) return "errored";

  // Review mode's evaluator scores the *subject under review*, not hivekit's
  // own work: a low score means "this codebase has problems", which is a
  // successfully delivered review, not a failed run.
  //
  // This exit-0 path requires an EXPLICIT `--mode review`. A defaulted or
  // keyword-inferred review takes the strict path below, so the softer
  // semantics can never be reached by accident.
  if (mode === "review" && explicitMode === true) {
    return terminalStatus === "errored" ? "errored" : "review_completed";
  }

  if (terminalStatus === "passed") return "passed";

  if (roundsRun >= maxRounds) {
    // Rounds ran out. If no round ever produced a real verdict, nothing was
    // ever verified — that is an error, not a series of rejections.
    return anyJudged ? "max_rounds_exhausted" : "errored";
  }

  return terminalStatus === "errored" ? "errored" : "failed";
}

export interface ResultInput {
  runId: string;
  mode: Mode;
  outcome: RunOutcome;
  evaluatorStatus?: EvaluationStatus;
  evaluatorReason?: EvaluationReason;
  roundsRun: number;
  maxRounds: number;
  threshold: number;
  scores?: CriterionScore[];
  reportPath: string;
  error?: string;
  timestamp?: string;
}

/** Build the machine-readable run result. Pure apart from the default clock. */
export function buildRunResult(input: ResultInput): RunResult {
  const exitCode = exitCodeFor(input.outcome);
  const result: RunResult = {
    schemaVersion: 1,
    runId: input.runId,
    mode: input.mode,
    outcome: input.outcome,
    result: resultLabelFor(input.outcome),
    ok: isSuccessOutcome(input.outcome),
    exitCode,
    evaluator: {
      status: input.evaluatorStatus ?? "not_reached",
      reason: input.evaluatorReason ?? "not_reached",
      roundsRun: input.roundsRun,
      maxRounds: input.maxRounds,
      threshold: input.threshold,
      scores: input.scores ?? [],
    },
    reportPath: input.reportPath,
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
  if (input.error !== undefined) result.error = input.error;

  // Belt and braces: ok must never disagree with the exit code.
  if (result.ok !== (exitCode === 0)) {
    throw new Error(
      `buildRunResult: ok/exitCode disagree for outcome "${input.outcome}"`
    );
  }

  // A success outcome must be BACKED by an evaluator verdict in hand. Without
  // this, a future call site could pass outcome:"passed" alongside a failing
  // evaluation and mint a verified success out of nothing.
  if (input.outcome === "passed" && input.evaluatorStatus !== "passed") {
    throw new Error(
      `buildRunResult: outcome "passed" requires an evaluator PASS, got "${input.evaluatorStatus ?? "none"}"`
    );
  }
  if (
    input.outcome === "review_completed" &&
    (input.mode !== "review" || input.evaluatorStatus === undefined || input.evaluatorStatus === "errored")
  ) {
    throw new Error(
      `buildRunResult: outcome "review_completed" requires mode=review and a real evaluator verdict (mode="${input.mode}", status="${input.evaluatorStatus ?? "none"}")`
    );
  }
  return result;
}

const BANNER_OPEN = "<!-- hivekit:verdict v1 -->";
const BANNER_CLOSE = "<!-- /hivekit:verdict -->";

/**
 * The authoritative verdict block prepended to report.md.
 *
 * Everything below it in the file was written by an agent and is unverified
 * prose. The banner says so explicitly so that a reader who scrolls past it and
 * sees a success claim has already been told which one to believe.
 *
 * The warning deliberately avoids writing any success token itself: a caller
 * running `grep -i "result: pass"` over a failed run's report must get zero
 * hits, and hivekit's own boilerplate must not be one of them.
 */
export function renderVerdictBanner(result: RunResult): string {
  const lines = [
    BANNER_OPEN,
    `# HIVEKIT RESULT: ${result.result}`,
    "",
    `- **Outcome:** \`${result.outcome}\``,
    `- **Evaluator verdict:** \`${result.evaluator.status}\` (\`${result.evaluator.reason}\`)`,
    `- **Rounds:** ${result.evaluator.roundsRun}/${result.evaluator.maxRounds}`,
    `- **Exit code:** ${result.exitCode}`,
    `- **Run ID:** ${result.runId}`,
  ];
  // Single-line: a multi-line error message would otherwise push the banner past
  // stripVerdictBanner's block-size cap, orphaning its own open marker.
  if (result.error) {
    lines.push(`- **Error:** ${result.error.replace(/\s*[\r\n]+\s*/g, " ⏎ ").slice(0, 500)}`);
  }
  if (!result.ok) {
    lines.push(
      "",
      "> **This run did not pass verification.** The content below this banner was",
      "> written by an evaluator agent and is UNVERIFIED prose. Any success claim",
      "> below has been annotated as overridden; hivekit's verdict is the line",
      "> above and the `outcome` field in `result.json`."
    );
  }
  lines.push(BANNER_CLOSE, "");
  return lines.join("\n");
}

/**
 * A verdict claim is a LABEL, a SEPARATOR, then a SUCCESS TOKEN that ends the
 * line (bar trailing punctuation or markup).
 *
 * All three constraints earn their place. Proximity alone matched a plain `-`
 * bullet and a table cell — the shapes the old line-anchored pattern missed —
 * but it also mangled a dozen legitimate report lines: "the evaluation
 * completed in 40s" (no separator), "Outcome: complete failure of the auth
 * path" and "Status: complete rewrite required" (token not final, and both
 * INVERTED in meaning once annotated). Requiring a separator kills the first
 * class; requiring the token to end the line kills the second.
 */
const VERDICT_LABEL =
  "(?:result|status|verdict|evaluation|outcome|overall|conclusion|gate|assessment|decision|sign-?off|recommendation|summary|judge?ment|ready)";
const SUCCESS_TOKEN =
  "(?:pass(?:ed|ing)?|success(?:ful)?|succeeded|ok|green|accepted|approved|shipped|complete[d]?|✅|✔️?)";
/** Markup, an HTML tag, or spacing; then a real separator; then more markup. */
const SEPARATOR =
  "(?:</?[a-zA-Z][^>\\n]{0,20}>|[*_`\\s\\]\\)>]){0,8}[:|=—–-][^A-Za-z0-9\\n]{0,12}";
/**
 * Token must run to end of line, allowing trailing markup like ` |` or ` -->`,
 * plus one short bracketed suffix (`PASS <ok>`, `PASS (all green)`). The suffix
 * allowance is deliberately narrow: "Outcome: complete failure of the auth path"
 * must still read as prose, not as a suppressed claim.
 */
const TRAILING_SUFFIX = "(?:[^\\S\\r\\n]*[<(\\[][^>)\\]\\n]{0,16}[>)\\]])?";
const AGENT_VERDICT_CLAIM = new RegExp(
  `\\b${VERDICT_LABEL}\\b${SEPARATOR}${SUCCESS_TOKEN}${TRAILING_SUFFIX}(?=[^A-Za-z0-9\\n]*$)`,
  "gim"
);

/** Inline code spans and fenced blocks — quoted code is data, not a claim. */
const CODE_REGIONS = /(?:^```[\s\S]*?^```|^~~~[\s\S]*?^~~~|`[^`\n]*`)/gm;
/**
 * A code region is protected only when it actually LOOKS LIKE CODE — it holds a
 * bracket, an operator, a semicolon or a quoted string.
 *
 * Both simpler rules failed. Skipping every region unconditionally let
 * `` `Result`: PASS `` through, because the backticks hid the LABEL. Skipping a
 * region *because it contains a success token* was worse: that describes
 * precisely the region that needs neutralising, so any claim wrapped in
 * backticks or a fence — `` `Result: PASS` ``, a fenced `Result: PASS`, even a
 * fenced forged `HIVEKIT RESULT: PASSED` banner — survived intact on a failed
 * run. Shape, not content, is what distinguishes quoted code from a quoted
 * verdict.
 */
const LOOKS_LIKE_CODE = /[{}();=<>[\]]|["'].*["']/;

/**
 * A code span whose ENTIRE content is a verdict claim — `` `Result: PASS` ``.
 * Handled separately because the end-of-line rule (which is what stops
 * "Outcome: complete failure of the auth path" being mangled) otherwise lets a
 * claim ride mid-sentence: "the verdict is `Result: PASS` per the evaluator".
 * Wrapping a claim in backticks does not make it a quotation of code.
 */
const CLAIM_ONLY_SPAN = new RegExp(
  `^[^\\S\\r\\n]*${VERDICT_LABEL}${SEPARATOR}${SUCCESS_TOKEN}${TRAILING_SUFFIX}[^A-Za-z0-9]*$`,
  "i"
);

/**
 * Neutralise agent-authored success claims in a markdown report.
 *
 * Only the claim phrase is replaced — surrounding prose, findings and reasoning
 * are untouched — and code spans and fenced blocks are skipped entirely, so a
 * quoted `{"status": "ok"}` or `if (result === OK)` in the audit trail survives
 * verbatim. What cannot survive is a standalone success token, so a human
 * skimming, or a caller grepping, a failed run's report cannot mistake agent
 * prose for hivekit's verdict.
 */
export function neutralizeAgentVerdictClaims(
  markdown: string,
  authoritative: string
): string {
  // The marker deliberately contains no success token and no verdict label:
  // an earlier version said "SUCCESS CLAIM OVERRIDDEN", so a second label
  // earlier on the line ("Outcome — Result: PASS") re-matched the annotation
  // and the function was not idempotent.
  const marker = `[CLAIM OVERRIDDEN BY HIVEKIT — ${authoritative}]`;

  // Inline spans that are nothing but a claim are claims, not code.
  markdown = markdown.replace(/`([^`\n]*)`/g, (full, inner: string) =>
    CLAIM_ONLY_SPAN.test(inner) ? marker : full
  );

  // Split into code / non-code regions and only rewrite the non-code ones.
  let out = "";
  let last = 0;
  CODE_REGIONS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CODE_REGIONS.exec(markdown)) !== null) {
    const region = m[0];
    if (!LOOKS_LIKE_CODE.test(region)) continue; // prose in backticks is not a shield
    out += markdown.slice(last, m.index).replace(AGENT_VERDICT_CLAIM, () => marker);
    // Protection is per-LINE, not per-region. A fence that legitimately holds
    // code and ALSO holds a claim was otherwise shielded wholesale — one `[` or
    // `=` anywhere in the block was enough to smuggle a "Result: PASS" through.
    out += protectCodeRegion(region, marker);
    last = m.index + region.length;
  }
  out += markdown.slice(last).replace(AGENT_VERDICT_CLAIM, () => marker);
  return out;
}

/**
 * Keep a code region verbatim except for lines that are nothing but a verdict
 * claim. Real code lines survive; a claim does not become code by sharing a
 * fence with one.
 */
function protectCodeRegion(region: string, marker: string): string {
  return region
    .split("\n")
    // Trim the code markup off the line before judging it: `Result: PASS <ok>`
    // is a claim wearing backticks, not a line of code.
    .map((line) => (CLAIM_ONLY_SPAN.test(line.replace(/^[\s`~]+|[\s`~]+$/g, "")) ? marker : line))
    .join("\n");
}

/**
 * Remove EVERY hivekit banner block from a document.
 *
 * Line-based and bounded, deliberately. A lazy `OPEN[\s\S]*?CLOSE` regex was
 * quadratic on unmatched OPEN markers (~0.8s at 20k of them) and would delete a
 * whole document when one stray OPEN paired with a far-away CLOSE. Scanning
 * lines with a size cap is linear and confines the damage: an unterminated
 * banner drops its own marker line and nothing else.
 *
 * Handles two hostile shapes: an agent forging its own `HIVEKIT RESULT: PASSED`
 * banner (a second block that would otherwise survive for `tail`- or
 * last-match-wins readers), and a banner appearing mid-document (which a
 * slice-from-first-close implementation silently truncated everything above).
 */
const MAX_BANNER_LINES = 40;

export function stripVerdictBanner(markdown: string): string {
  const lines = markdown.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== BANNER_OPEN) {
      // A stray close marker is dropped on its own.
      if (lines[i].trim() !== BANNER_CLOSE) kept.push(lines[i]);
      continue;
    }
    // Look ahead a bounded distance for the matching close.
    let close = -1;
    for (let j = i + 1; j < lines.length && j - i <= MAX_BANNER_LINES; j++) {
      if (lines[j].trim() === BANNER_CLOSE) { close = j; break; }
    }
    // No close within range: treat the open as an orphan, keep the content.
    if (close === -1) continue;
    i = close;
  }
  return kept.join("\n").replace(/^(?:\r?\n)+/, "");
}

/**
 * Compose the final report.md content: authoritative banner on top, agent prose
 * below with its success claims neutralised on anything but a verified pass.
 *
 * Note the condition is `outcome !== "passed"`, not `!ok`: review_completed
 * also exits 0, but it is not a verification of hivekit's own work, so an agent
 * PASS claim underneath it still gets annotated.
 */
export function composeReport(agentReport: string, result: RunResult): string {
  const body = stripVerdictBanner(agentReport);
  const safeBody =
    result.outcome === "passed"
      ? body
      : neutralizeAgentVerdictClaims(body, result.result);
  return `${renderVerdictBanner(result)}\n${safeBody}`;
}

/** Index-table status string. Failure statuses never contain "complete". */
export function indexStatusFor(outcome: RunOutcome): string {
  switch (outcome) {
    case "passed":
      return "complete";
    case "review_completed":
      return "review-complete";
    case "failed":
      return "failed-evaluator";
    case "max_rounds_exhausted":
      return "failed-max-rounds";
    case "errored":
      return "failed-evaluator-errored";
    case "crashed":
      return "failed-crashed";
  }
}
