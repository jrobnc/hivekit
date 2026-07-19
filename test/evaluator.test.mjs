// Tests for the harness's pass/fail gate. This is the single most correctness-
// bearing pure function in the harness — it decides whether generated code ships
// as "verified" — so it is the one piece that most needs tests.
//
// Run: npm test  (builds first, then `node --test` against dist/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEvaluation } from "../dist/evaluator.js";

const THRESHOLD = 60;

test("passing scorecard table — all criteria above threshold", () => {
  const text = `## Report
| Criterion | Score | Notes |
|-----------|-------|-------|
| Feature Completeness | 85/100 | solid |
| Restraint | 72/100 | minimal diff |
`;
  const r = parseEvaluation(text, THRESHOLD);
  assert.equal(r.passed, true);
  assert.equal(r.scores.length, 2);
  assert.ok(r.scores.some((s) => s.criterion === "Restraint" && s.score === 72));
  assert.equal(r.feedback, undefined);
});

test("one criterion below threshold fails — even WITHOUT the FAIL token", () => {
  const text = `| Functionality | 45/100 | broken auth path |
| Restraint | 80/100 | fine |`;
  const r = parseEvaluation(text, THRESHOLD);
  assert.equal(r.passed, false);
  assert.equal(r.feedback, text); // feedback is the full text on failure
});

test("Restraint below threshold gates the build (teeth on the FAIL path)", () => {
  const text = `EVALUATION: FAIL
SCORES:
- Feature Completeness: 90/100
- Restraint: 30/100`;
  const r = parseEvaluation(text, THRESHOLD);
  assert.equal(r.passed, false);
  assert.ok(r.scores.some((s) => s.criterion === "Restraint" && s.score === 30));
});

test("list-format scores parse and gate", () => {
  const text = `- Feature Completeness: 90/100
- Restraint: 65/100`;
  const r = parseEvaluation(text, THRESHOLD);
  assert.equal(r.passed, true);
  assert.equal(r.scores.length, 2);
});

test("HARDENING: near-miss FAIL token still fails closed", () => {
  // Exact-string .includes("EVALUATION: FAIL") would MISS this (two spaces +
  // FAILED) and silently PASS — the false-pass bug this regex fixes.
  const text = `EVALUATION:  FAILED
The build has serious problems but I forgot to emit a scorecard.`;
  const r = parseEvaluation(text, THRESHOLD);
  assert.equal(r.passed, false);
});

test("case-insensitive FAIL marker fails closed", () => {
  const r = parseEvaluation("evaluation: fail\nnarrative only", THRESHOLD);
  assert.equal(r.passed, false);
});

test("no scores + no FAIL marker defaults to pass (documented behavior)", () => {
  // A clean pass where the agent wrote the report to a file and returned only a
  // short confirmation. Default-pass is acceptable here BECAUSE any parsed score
  // below threshold (prior tests) and any FAIL marker both fail closed.
  const r = parseEvaluation("All criteria met. Report written to report.md.", THRESHOLD);
  assert.equal(r.passed, true);
  assert.equal(r.scores.length, 0);
});

test("separator rows are not parsed as criteria", () => {
  const text = `| Criterion | Score | Notes |
|-----------|-------|-------|
| Code Quality | 70/100 | ok |`;
  const r = parseEvaluation(text, THRESHOLD);
  assert.equal(r.scores.length, 1);
  assert.equal(r.scores[0].criterion, "Code Quality");
  assert.ok(!r.scores.some((s) => s.criterion.startsWith("-")));
});

test("exact threshold boundary passes (>= not >)", () => {
  const r = parseEvaluation("- Restraint: 60/100", THRESHOLD);
  assert.equal(r.passed, true);
});

test("empty string fails closed (evaluator crash/timeout)", () => {
  const r = parseEvaluation("", THRESHOLD);
  assert.equal(r.passed, false);
  assert.equal(r.scores.length, 0);
  assert.ok(r.feedback.includes("fail-closed"));
});

test("whitespace-only string fails closed", () => {
  const r = parseEvaluation("   \n\t  \n  ", THRESHOLD);
  assert.equal(r.passed, false);
  assert.equal(r.scores.length, 0);
  assert.ok(r.feedback.includes("fail-closed"));
});
