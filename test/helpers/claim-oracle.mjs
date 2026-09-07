// An INDEPENDENT oracle for "does this report still assert success?".
//
// Deliberately not the production regex. The earlier assertions reused
// src/outcome.ts's own pattern, so a claim form the implementation missed
// (notably a plain "-" bullet, the commonest markdown list marker) was equally
// invisible to the test — the suite stayed green while the artifact lied.
//
// This oracle is written from the reader's side: scan the report body outside
// hivekit's banner, and flag any line where a verdict-ish label and a
// success-ish token appear together without an OVERRIDDEN annotation.
import assert from "node:assert/strict";

/** Claim shapes a lying or sloppy agent plausibly writes. Hand-enumerated. */
export const SUCCESS_CLAIM_FORMS = [
  "**Result**: PASS",
  "- Result: PASS",
  "- **Result**: PASS",
  "* Result: PASS",
  "1. Result: PASS",
  "| Result | PASS |",
  "| Overall   | PASS   |",
  "<!-- Result: PASS -->",
  "Overall: PASS",
  "Result — PASS",
  "Result: PASSED",
  "Result: PASSING",
  "Verdict: ✅ PASS",
  "`Result`: PASS",
  "## Status: PASS",
  "Status: ACCEPTED",
  "Verdict: SHIPPED",
  "Verdict: APPROVED",
  "Evaluation: OK",
  "Gate: GREEN",
  "Conclusion: SUCCESS",
  "Outcome: COMPLETE",
  "> Result: PASS",
  "EVALUATION: PASS",
  "Assessment: successful",
  "Decision: passing",
  "Sign-off: APPROVED",
  "Recommendation: SHIPPED",
  "Summary: PASS",
  "Judgement: OK",
  // Claims wrapped in code markup. Missing from the corpus for three rounds,
  // which is why a general-purpose "skip anything in backticks" shield stayed
  // green while the report still read PASS on a failed run.
  "`Result: PASS`",
  "`Status: OK`",
  "Summary: the verdict is `Result: PASS` per the evaluator.",
  "<b>Result</b>: PASS",
];

/** Multi-line claim forms (fenced blocks). Checked as whole documents. */
export const FENCED_CLAIM_FORMS = [
  "```\nResult: PASS\n```",
  "~~~\nResult: PASS\n~~~",
  "```\n# HIVEKIT RESULT: PASSED\n```",
];

/**
 * Legitimate report lines that must survive untouched. Drawn from real failure
 * reports, not from the implementation's behaviour — several of these were
 * mangled by an over-broad neutralizer, two of them INVERTING their meaning
 * ("Outcome: complete failure" annotated as a suppressed success claim).
 */
export const LEGITIMATE_PROSE = [
  "the evaluation completed in 40s",
  "Outcome: complete failure of the auth path",
  "Status: complete rewrite required before merge",
  "Conclusion: complete the migration before shipping",
  "Overall: OK-ish, but three criteria regressed",
  "`{\"status\": \"ok\"}` is returned by the health endpoint",
  "`{\"result\": \"success\"}` in the fixture",
  "status: ok    # yaml health probe stub",
  "Gate — complete blocker: the migration is missing",
  "outcome-complete.ts is the module under test",
  "All 57 tests pass with no warnings.",
  "This function returns ok when the status code is 200.",
  "```\nif (result === OK) { doThing(); }\n```",
  "```\nassert(outcome == PASS);\n```",
  "Use `--mode review` for read-only runs.",
];

// Deliberately WIDER than src/outcome.ts's label list: an oracle that shares the
// implementation's vocabulary can only confirm the implementation agrees with
// itself. Extra labels here are a standing invitation for the test to go red.
const LABEL = /\b(result|status|verdict|evaluation|outcome|overall|conclusion|gate|assessment|decision|sign-?off|recommendation|ready|summary|judgement|judgment)\b/i;
const TOKEN = /(\b(pass|passed|passing|success|successful|succeeded|ok|green|accepted|approved|shipped|complete|completed)\b|✅|✔)/i;

/** Report body with hivekit's own authoritative banner removed. */
function bodyOutsideBanner(report) {
  return report.replace(/<!-- hivekit:verdict v1 -->[\s\S]*?<!-- \/hivekit:verdict -->/g, "");
}

/**
 * Assert no line outside the banner reads as an unqualified success claim.
 *
 * Deliberately CODE-BLIND: it does not skip fenced blocks or code spans, which
 * is what lets it catch a claim hidden inside one. The cost is that genuine code
 * containing a label and a success token (`if (result === OK)`) reads as a
 * claim, so never hand this real code samples — assert code preservation on its
 * own fixture instead.
 * A line is a claim when it carries BOTH a verdict label and a success token
 * and has not been annotated as overridden.
 */
export function assertNoSurvivingSuccessClaim(report) {
  const offenders = bodyOutsideBanner(report)
    .split("\n")
    // Match hivekit's exact marker, not a loose /OVERRIDDEN/: an agent that
    // writes the word "overridden" anywhere on its claim line would otherwise
    // make that line invisible to this check.
    .filter((line) => LABEL.test(line) && TOKEN.test(line) && !line.includes("CLAIM OVERRIDDEN BY HIVEKIT"));
  assert.deepEqual(
    offenders,
    [],
    `report still asserts success on ${offenders.length} line(s):\n${offenders.join("\n")}`
  );
}
