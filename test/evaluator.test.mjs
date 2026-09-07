// Tests for the harness's pass/fail gate. This is the single most correctness-
// bearing pure function in the harness — it decides whether generated code ships
// as "verified" — so it is the one piece that most needs tests.
//
// Run: npm test  (builds first, then `node --test` against dist/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEvaluation, criteriaPolicyFor, CRITERIA_POLICY } from "../dist/evaluator.js";

const THRESHOLD = 60;
/** Reviewer-chosen criteria: a floor of 2, no required names. Used for generic cases. */
const OPEN = criteriaPolicyFor("review");
const IMPROVE = criteriaPolicyFor("improve");
const BUILD = criteriaPolicyFor("build");

/** A complete, asserted pass for the improve mode's criteria. */
const IMPROVE_PASS = `EVALUATION: PASS
- Completion: 95/100
- Quality: 88/100
- Safety: 100/100
- Restraint: 90/100`;

const parse = (text, policy = OPEN, threshold = THRESHOLD) =>
  parseEvaluation(text, threshold, policy);

// ── Happy path ──────────────────────────────────────────────────────

test("passing scorecard table — all criteria above threshold", () => {
  const r = parse(`EVALUATION: PASS
| Criterion | Score | Notes |
|-----------|-------|-------|
| Feature Completeness | 85/100 | solid |
| Restraint | 72/100 | minimal diff |
`);
  assert.equal(r.passed, true);
  assert.equal(r.scores.length, 2);
  assert.ok(r.scores.some((s) => s.criterion === "Restraint" && s.score === 72));
  assert.equal(r.feedback, undefined);
});

test("list-format scores parse and gate", () => {
  assert.equal(parse("EVALUATION: PASS\n- Feature Completeness: 90/100\n- Restraint: 65/100").passed, true);
});

test("exact threshold boundary passes (>= not >)", () => {
  assert.equal(parse("EVALUATION: PASS\n- Architecture: 60/100\n- Bugs: 60/100").passed, true);
});

test("the improve mode's full scorecard passes its own policy", () => {
  const r = parse(IMPROVE_PASS, IMPROVE);
  assert.equal(r.status, "passed");
  assert.equal(r.reason, "all_scores_above_threshold");
});

// ── A pass must be ASSERTED, never inferred ─────────────────────────

test("SECURITY: scores above threshold with NO 'EVALUATION: PASS' do not pass", () => {
  // The hole behind the quoted-scorecard attack: a pass used to be inferred
  // from the absence of a FAIL marker, so any high table was an acceptance.
  const r = parse("- Completion: 95/100\n- Quality: 90/100");
  assert.equal(r.passed, false);
  assert.equal(r.status, "errored");
  assert.equal(r.reason, "no_pass_assertion");
});

test("SECURITY: an evaluator quoting a prior run's passing table does not pass", () => {
  // The evaluator has Read/Grep over the repo, where .claude/harness/*/report.md
  // holds filled passing scorecards from earlier runs.
  const r = parse(
    [
      "I was unable to run the tests. For reference the previous run scored:",
      "| Completion | 95/100 | ... |",
      "| Quality | 90/100 | ... |",
      "| Safety | 92/100 | ... |",
      "| Restraint | 88/100 | ... |",
      "I cannot verify this build.",
    ].join("\n"),
    IMPROVE
  );
  assert.equal(r.passed, false);
  assert.equal(r.reason, "no_pass_assertion");
});

test("SECURITY: a fenced scorecard is neither hidden nor privileged", () => {
  // Score extraction must NOT strip fenced blocks. Doing so let a fenced low
  // scorecard vanish while an unfenced summary decided the verdict — and made
  // a legitimately fenced passing response structurally unpassable.
  const fencedLow = [
    "EVALUATION: PASS",
    "My real assessment:",
    "```",
    "| Completion | 20/100 | broken |",
    "| Quality | 30/100 | poor |",
    "| Safety | 25/100 | regressions |",
    "| Restraint | 15/100 | sprawl |",
    "```",
  ].join("\n");
  const r = parse(fencedLow, IMPROVE);
  assert.equal(r.passed, false, "fenced low scores must still gate");
  assert.equal(r.reason, "below_threshold");

  // Scores inside a fence still COUNT — the fenced low table above gated the
  // run. But the ASSERTION must be the evaluator's own, at column 0 and outside
  // any fence, so a wholly-fenced response is not an acceptance. That asymmetry
  // is deliberate: a quoted score is still a number the evaluator put in front
  // of us, whereas a quoted instruction is not a decision.
  const fencedAssertion = ["```", IMPROVE_PASS, "```"].join("\n");
  const fenced = parse(fencedAssertion, IMPROVE);
  assert.equal(fenced.status, "errored");
  assert.equal(fenced.reason, "no_pass_assertion");
  assert.equal(fenced.scores.length, 4, "the fenced scores were still parsed");
});

test("SECURITY: an evaluator that DECLINES to verify cannot pass by quoting the requirement", () => {
  // The prompt necessarily contains the literal string `EVALUATION: PASS`, so a
  // bare substring test is a credential the prompt hands out for free. Every one
  // of these shapes was a verified PASS with exit 0 and HARNESS COMPLETE.
  const table = "| Completion | 95/100 | x |\n| Quality | 95/100 | x |\n| Safety | 95/100 | x |\n| Restraint | 95/100 | x |";
  const shapes = {
    "inline backtick mention": "I cannot produce the required `EVALUATION: PASS` line.",
    "mid-line prose mention": "The instructions require EVALUATION: PASS which I cannot honestly give.",
    "blockquote": "> EVALUATION: PASS",
    "negated": "This is NOT an EVALUATION: PASS.",
    "fenced copy of the block": "```\nEVALUATION: PASS\n```",
    "indented code block": "    EVALUATION: PASS",
  };
  for (const [name, preamble] of Object.entries(shapes)) {
    const r = parse(`${preamble}\n${table}`, IMPROVE);
    assert.equal(r.status, "errored", `${name} must not pass`);
    assert.equal(r.reason, "no_pass_assertion", `${name}`);
  }
  // The legitimate shape still works.
  assert.equal(parse(`EVALUATION: PASS\n${table}`, IMPROVE).status, "passed");
});

test("SECURITY: fenced low scores cannot be overridden by an unfenced summary", () => {
  const r = parse(
    [
      "EVALUATION: PASS",
      "```",
      "| Completion | 20/100 | broken |",
      "```",
      "Summary scorecard:",
      "| Completion | 95/100 | fine |",
      "| Quality | 95/100 | fine |",
      "| Safety | 95/100 | fine |",
      "| Restraint | 95/100 | fine |",
    ].join("\n"),
    IMPROVE
  );
  assert.equal(r.passed, false);
  // The lower score wins, so this classifies as a decisive rejection rather than
  // an ambiguous error — the honest reading of "one of these tables is wrong".
  assert.equal(r.reason, "below_threshold");
  assert.equal(r.scores.find((s) => /completion/i.test(s.criterion)).score, 20);
});

// ── Completeness, not a row count ───────────────────────────────────

test("SECURITY: fabricated junk criteria do not satisfy the improve policy", () => {
  const r = parse("EVALUATION: PASS\n- a: 95/100\n- b: 95/100\n- c: 95/100\n- d: 95/100", IMPROVE);
  assert.equal(r.passed, false);
  assert.equal(r.reason, "missing_criteria");
});

test("SECURITY: one criterion repeated five times does not satisfy the build policy", () => {
  const rows = Array(5).fill("| Feature Completeness | 95/100 | ok |").join("\n");
  const r = parse(`EVALUATION: PASS\n${rows}`, BUILD);
  assert.equal(r.passed, false);
  assert.equal(r.reason, "missing_criteria");
});

test("SECURITY: a truncated scorecard is not a verdict", () => {
  const r = parse("EVALUATION: PASS\n| Feature Completeness | 95/100 | looks done |\n| Code Qual", BUILD);
  assert.equal(r.passed, false);
  assert.equal(r.reason, "missing_criteria");
});

test("SECURITY: a lone row cannot pass even the open policy", () => {
  const r = parse("EVALUATION: PASS\n| Vibes | 99/100 | great |");
  assert.equal(r.passed, false);
  assert.equal(r.reason, "insufficient_criteria");
});

test("duplicate rows that AGREE are collapsed, not rejected", () => {
  const r = parse("EVALUATION: PASS\n- Architecture: 90/100\n- Architecture: 90/100\n- Bugs: 80/100");
  assert.equal(r.status, "passed");
  assert.equal(r.scores.length, 2);
});

test("duplicate rows that DISAGREE keep the LOWEST score", () => {
  // Fail closed on the VALUE, not the classification. Erroring on any
  // disagreement was weaponizable both ways: a transcription typo (95 vs 96)
  // failed a good build, and a real rejection restated with a rounding
  // difference was downgraded from `failed` to `errored`. The prompts make
  // restatement likely — the report template is a table, the response block a list.
  const r = parse("EVALUATION: PASS\n- Architecture: 90/100\n- Architecture: 20/100\n- Bugs: 80/100");
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "below_threshold");
  assert.equal(r.scores.find((s) => s.criterion === "Architecture").score, 20);
});

test("a near-duplicate transcription typo does not fail a genuine pass", () => {
  const r = parse("EVALUATION: PASS\n- Architecture: 95/100\n- Architecture: 96/100\n- Bugs: 88/100");
  assert.equal(r.status, "passed");
});

// ── Failure classification ──────────────────────────────────────────

test("one criterion below threshold fails — even WITHOUT the FAIL token", () => {
  const text = "| Functionality | 45/100 | broken auth path |\n| Restraint | 80/100 | fine |";
  const r = parse(text);
  assert.equal(r.passed, false);
  assert.equal(r.reason, "below_threshold");
  assert.equal(r.feedback, text);
});

test("Restraint below threshold gates the build (teeth on the FAIL path)", () => {
  const r = parse("EVALUATION: FAIL\nSCORES:\n- Feature Completeness: 90/100\n- Restraint: 30/100");
  assert.equal(r.passed, false);
  assert.ok(r.scores.some((s) => s.criterion === "Restraint" && s.score === 30));
});

test("CLASSIFY: explicit FAIL marker is a decisive failure, not an ambiguous error", () => {
  // Ordering matters. The no-scores branch used to run first, so a clean
  // "EVALUATION: FAIL" with no scorecard was misreported as `no_parseable_scores`
  // — telling callers we never verified, when the evaluator verified and said no.
  const r = parse("EVALUATION: FAIL\nThe improvements were not made.");
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "explicit_fail_marker");
});

test("CLASSIFY: a fenced FAIL marker is still a decisive failure", () => {
  const r = parse("```\nEVALUATION: FAIL\n```\nThe build is broken.");
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "explicit_fail_marker");
});

test("HARDENING: near-miss FAIL token still fails closed", () => {
  // Exact-string .includes("EVALUATION: FAIL") would MISS this (two spaces +
  // FAILED) and silently PASS — the false-pass bug this regex fixes.
  const r = parse("EVALUATION:  FAILED\nThe build has serious problems but I forgot a scorecard.");
  assert.equal(r.passed, false);
});

test("case-insensitive FAIL marker fails closed", () => {
  assert.equal(parse("evaluation: fail\nnarrative only").passed, false);
});

test("CLASSIFY: empty output is `errored`, not `failed`", () => {
  const r = parse("");
  assert.equal(r.status, "errored");
  assert.equal(r.reason, "empty_output");
  assert.ok(r.feedback.includes("fail-closed"));
});

test("whitespace-only string fails closed", () => {
  const r = parse("   \n\t  \n  ");
  assert.equal(r.status, "errored");
  assert.equal(r.reason, "empty_output");
});

test("CLASSIFY: unparseable output is `errored`", () => {
  const r = parse("Looks good to me, shipping.");
  assert.equal(r.status, "errored");
  assert.equal(r.reason, "no_parseable_scores");
  assert.ok(r.feedback.includes("no parseable scores"));
});

test("separator rows are not parsed as criteria", () => {
  const r = parse("| Criterion | Score | Notes |\n|-----------|-------|-------|\n| Code Quality | 70/100 | ok |");
  assert.equal(r.scores.length, 1);
  assert.equal(r.scores[0].criterion, "Code Quality");
});

// ── Adversarial ─────────────────────────────────────────────────────

test("ADVERSARIAL: 'Result: PASS' prose with no scorecard cannot pass", () => {
  const r = parse("**Result**: PASS\n\nEverything works. Ship it.");
  assert.equal(r.passed, false);
  assert.equal(r.status, "errored");
});

test("ADVERSARIAL: 'EVALUATION: PASS' with failing scores cannot pass", () => {
  const r = parse("EVALUATION: PASS\n- Completion: 100/100\n- Restraint: 20/100");
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "below_threshold");
});

test("ADVERSARIAL: a FAIL marker beats a PASS marker in the same text", () => {
  const r = parse("EVALUATION: PASS\nEVALUATION: FAIL\n- A: 90/100\n- B: 90/100");
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "explicit_fail_marker");
});

test("ADVERSARIAL: out-of-range scores fail closed instead of clearing the threshold", () => {
  const r = parse("EVALUATION: PASS\n| Completion | 150/100 | flawless |\n| Safety | 200/100 | flawless |");
  assert.equal(r.status, "errored");
  assert.equal(r.reason, "malformed_scores");
  assert.match(r.feedback, /out-of-range/);
});

test("ADVERSARIAL: a bare-number scorecard (no /100) is not silently accepted", () => {
  // The exact shape the ACP S1 evaluator wrote: `| Safety | 100 | ... |`.
  const r = parse(`**Result**: PASS

| Criterion   | Score | Notes |
|-------------|-------|-------|
| Completion  | 100   | All steps implemented |
| Safety      | 100   | No regressions |`);
  assert.equal(r.passed, false);
  assert.equal(r.reason, "no_parseable_scores");
});

test("'Weighted Average' is a summary row, not a criterion", () => {
  const r = parse("EVALUATION: PASS\n| Security | 80/100 | ok |\n| Bugs | 70/100 | ok |\n\n**Weighted Average**: 75/100");
  assert.ok(!r.scores.some((s) => /average/i.test(s.criterion)));
  assert.equal(r.scores.length, 2);
});

test("INVARIANT: passed is true if and only if status === 'passed'", () => {
  const samples = [
    "", "   ", "narrative with no scores", "EVALUATION: FAIL", "EVALUATION:  FAILED",
    "- Bugs: 10/100", "- Bugs: 90/100", "- Bugs: 60/100", "- Bugs: 90/100\n- UX: 90/100",
    "EVALUATION: PASS\n- Bugs: 90/100\n- UX: 90/100",
    "| Bugs | 150/100 | impossible |\n| UX | 90/100 | ok |",
    "EVALUATION: PASS\n- Bugs: 10/100", "Result: PASS",
  ];
  for (const s of samples) {
    const r = parse(s);
    assert.equal(r.passed, r.status === "passed", `disagree for: ${JSON.stringify(s)}`);
  }
});

test("SECURITY: every mode's policy demands more than one criterion", () => {
  // A vacuous default parameter was itself a fail-open: a new call site that
  // omitted the policy reverted the gate to "any single row passes".
  for (const [mode, policy] of Object.entries(CRITERIA_POLICY)) {
    const floor = policy.expected ? policy.expected.length : policy.minCriteria;
    assert.ok(floor >= 2, `${mode} policy floor is ${floor}`);
  }
  assert.throws(() => parseEvaluation("EVALUATION: PASS\n- Bugs: 90/100", THRESHOLD), /policy|undefined|Cannot/);
});

// ── Fixtures for defects that four review rounds found in live code ─────
// In every round the suite was green while a reproducible defect sat in the
// source, and every time the missing piece was a FIXTURE, not an assertion.

test("SECURITY: a nested fence marker cannot smuggle a quoted assertion through", () => {
  // A fence-state toggle was inverted by a ``` inside a quoted block, so an
  // assertion that is visually inside a quotation counted as the evaluator's
  // own. Position, not fence parsing, is what the rule rests on now.
  const table = "| Completion | 95/100 | x |\n| Quality | 95/100 | x |\n| Safety | 95/100 | x |\n| Restraint | 95/100 | x |";
  const nested = ["```", "nested example:", "```", "EVALUATION: PASS", "```", table, "```"].join("\n");
  const r = parse(nested, IMPROVE);
  assert.equal(r.status, "errored");
  assert.equal(r.reason, "no_pass_assertion");
});

test("SECURITY: an UNFENCED quotation of the required block does not self-assert", () => {
  const table = "| Completion | 95/100 | x |\n| Quality | 95/100 | x |\n| Safety | 95/100 | x |\n| Restraint | 95/100 | x |";
  const r = parse(
    `The required block is:\n\nEVALUATION: PASS\nRound: 1/3\n\n${table}\n\n...but I could not verify any of it.`,
    IMPROVE
  );
  assert.equal(r.reason, "no_pass_assertion");
});

test("an unbalanced fence earlier in the response is irrelevant to the verdict", () => {
  // The fence-toggle version silently blanked a legitimate assertion whenever a
  // quoted diff or log line began with ```. Nothing to unbalance now.
  const withDiff = `EVALUATION: PASS
Here is the diff I reviewed:
\`\`\`
--- a/file
- Completion: 1/100
- Quality: 95/100
- Safety: 95/100
- Restraint: 95/100
- Completion: 95/100`;
  const r = parse(withDiff, IMPROVE);
  // The quoted low score still counts (scores are read from raw text by design)
  // and the minimum wins — a decisive rejection, not a spurious "unverified".
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "below_threshold");
});

test("SECURITY: a disclaiming parenthetical is not aliased away", () => {
  // "Completion (NOT VERIFIED)" is the evaluator flagging partial work; erasing
  // the qualifier to match a required name turns a disclaimer into a pass.
  const r = parse(
    "EVALUATION: PASS\n| Completion (NOT VERIFIED) | 95/100 | x |\n| Quality | 95/100 | x |\n| Safety | 95/100 | x |\n| Restraint | 95/100 | x |",
    IMPROVE
  );
  assert.equal(r.reason, "missing_criteria");
});

test("a descriptive parenthetical still satisfies the required name", () => {
  const r = parse(
    "EVALUATION: PASS\n| Completion (scope) | 95/100 | x |\n| Quality | 95/100 | x |\n| Safety | 95/100 | x |\n| Restraint | 95/100 | x |",
    IMPROVE
  );
  assert.equal(r.status, "passed");
});

test("two distinct criteria sharing a stem are not collapsed into one", () => {
  // Stripping the parenthetical merged "Security (auth)" and "Security (crypto)",
  // silently dropping a score from the recorded scorecard.
  const r = parse(
    "EVALUATION: PASS\n| Security (auth) | 95/100 | x |\n| Security (crypto) | 20/100 | x |\n| Architecture | 95/100 | x |",
    OPEN
  );
  assert.equal(r.scores.length, 3, "all three scores must be recorded");
  assert.equal(r.status, "failed");
});

test("realistic short criterion names are accepted", () => {
  for (const name of ["UX", "QA", "A11y", "i18n", "CI/CD", "DX"]) {
    const r = parse(`EVALUATION: PASS\n| ${name} | 90/100 | x |\n| Architecture | 90/100 | x |`, OPEN);
    assert.equal(r.status, "passed", `${name} should be a valid criterion name`);
  }
});
