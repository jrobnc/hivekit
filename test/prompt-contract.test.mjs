// Contract test: every evaluator prompt's own PASS template must be accepted by
// parseEvaluation, and its FAIL template must be rejected.
//
// This is the test that would have caught the ACP S1 defect. evaluator-improve.md
// shipped a PASS template with no `xx/100` scorecard while the parser required
// one, so improve mode was STRUCTURALLY UNPASSABLE: the evaluator followed its
// prompt exactly, the parser fail-closed on "no parseable scores", and every
// improve run burned three rounds before exhausting them.
//
// Prompt text and parser are two halves of one contract held in different
// files and different languages. Nothing but a test can keep them in sync.
//
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEvaluation, criteriaPolicyFor } from "../dist/evaluator.js";

const PROMPTS = resolve(import.meta.dirname, "..", "src", "prompts");
const MODES = ["build", "improve", "review"];
const THRESHOLD = 60;

/** Pull every fenced block out of a prompt, with its (possibly empty) language. */
function allFences(md) {
  const re = /^```([a-z]*)\n([\s\S]*?)^```/gm;
  return [...md.matchAll(re)].map((m) => ({ lang: m[1], body: m[2] }));
}

/** Fenced blocks with a given language tag ("" for untagged). */
function fencedBlocks(md, lang) {
  return allFences(md).filter((f) => f.lang === lang).map((f) => f.body);
}

/** Templates use `xx/100` as a placeholder; fill it with a passing score. */
function fillScores(block, score) {
  return block.replace(/xx\/100/g, `${score}/100`);
}

/**
 * The block the prompt tells the evaluator to RETURN (what the parser reads).
 *
 * Delimited by explicit markers rather than a code fence: the prompt used to
 * show this block fenced while its own prose said "do not fence it", so a model
 * following the example literally failed the gate. Extracting fence bodies also
 * meant the test only ever validated the unfenced form and could not pin that
 * the fenced copy must NOT pass.
 */
function passResponseBlock(md) {
  const m = md.match(/<!-- hivekit:response-block -->\n([\s\S]*?)<!-- \/hivekit:response-block -->/);
  return m ? m[1] : undefined;
}

for (const mode of MODES) {
  const md = readFileSync(join(PROMPTS, `evaluator-${mode}.md`), "utf-8");
  const policy = criteriaPolicyFor(mode);

  test(`${mode}: the prompt's PASS response block is accepted by the parser`, () => {
    // The parser reads the evaluator's RETURNED TEXT, not the report file, so
    // this is the block that actually has to satisfy the gate.
    const block = passResponseBlock(md);
    assert.ok(block, `evaluator-${mode}.md defines no EVALUATION: PASS response block`);

    const r = parseEvaluation(fillScores(block, 95), THRESHOLD, policy);
    assert.equal(
      r.status,
      "passed",
      `evaluator-${mode}.md's PASS block does not parse as a pass (reason: ${r.reason}) — ` +
        `this mode cannot ever pass its own gate`
    );
  });

  test(`${mode}: the PASS block gates on the threshold`, () => {
    // Same block, scores below threshold, must be rejected — proving the
    // scorecard is load-bearing rather than incidentally present.
    const r = parseEvaluation(fillScores(passResponseBlock(md), 10), THRESHOLD, policy);
    assert.equal(r.status, "failed");
    assert.equal(r.reason, "below_threshold");
  });

  test(`${mode}: the PASS block names every criterion the mode's policy requires`, () => {
    // Guards the other half of the ACP S1 defect class: prompt and policy are
    // two halves of one contract, held in different files and languages.
    const r = parseEvaluation(fillScores(passResponseBlock(md), 95), THRESHOLD, policy);
    assert.notEqual(r.reason, "missing_criteria", `prompt omits criteria the policy requires`);
    assert.notEqual(r.reason, "insufficient_criteria", `prompt lists too few criteria`);
  });

  test(`${mode}: the report template alone is NOT enough to pass`, () => {
    // The report file is agent prose. Only the returned verdict block counts,
    // so a filled report template with no EVALUATION: PASS must fail closed.
    const [reportTemplate] = fencedBlocks(md, "markdown");
    if (!reportTemplate) return;
    const r = parseEvaluation(fillScores(reportTemplate, 95), THRESHOLD, policy);
    assert.notEqual(r.status, "passed", "a report template must not by itself constitute a pass");
  });

  test(`${mode}: a FENCED copy of the required block does NOT pass`, () => {
    // The verdict must be the response's first line. A model that pastes the
    // block inside a fence is quoting the requirement, not meeting it — and the
    // prompt must never demonstrate that shape.
    const fenced = "```\n" + fillScores(passResponseBlock(md), 95) + "```";
    const r = parseEvaluation(fenced, THRESHOLD, policy);
    assert.equal(r.status, "errored");
    assert.equal(r.reason, "no_pass_assertion");
  });

  test(`${mode}: the prompt does not demonstrate the block inside a code fence`, () => {
    const block = passResponseBlock(md);
    const idx = md.indexOf(block);
    const before = md.slice(Math.max(0, idx - 400), idx);
    assert.doesNotMatch(
      before.split("<!-- hivekit:response-block -->")[0].slice(-80),
      /```\s*$/,
      `evaluator-${mode}.md shows the required block fenced while telling the agent not to fence it`
    );
  });

  test(`${mode}: a preamble before the verdict line does NOT pass`, () => {
    const withPreamble = "Here is my assessment.\n\n" + fillScores(passResponseBlock(md), 95);
    const r = parseEvaluation(withPreamble, THRESHOLD, policy);
    assert.equal(r.reason, "no_pass_assertion");
  });

  test(`${mode}: no template instructs the agent to write a bare "Result: PASS"`, () => {
    // hivekit owns the verdict. An agent-authored PASS token in report.md is
    // exactly what made a 3x-FAILED run look successful to a human reader.
    assert.doesNotMatch(
      md,
      /^[^\S\r\n]*\**Result\**:[^\S\r\n]*\**PASS\b/im,
      `evaluator-${mode}.md still tells the agent to emit a bare "Result: PASS"`
    );
  });
}

test("build/improve FAIL templates are classified as a decisive failure", () => {
  for (const mode of ["build", "improve"]) {
    const md = readFileSync(join(PROMPTS, `evaluator-${mode}.md`), "utf-8");
    const failTemplate = allFences(md)
      .map((f) => f.body)
      .find((b) => /EVALUATION:\s*FAIL/i.test(b));
    assert.ok(failTemplate, `evaluator-${mode}.md has no EVALUATION: FAIL template`);

    const r = parseEvaluation(fillScores(failTemplate, 95), THRESHOLD, criteriaPolicyFor(mode));
    assert.equal(r.status, "failed", `${mode} FAIL template must classify as failed`);
    assert.equal(
      r.reason,
      "explicit_fail_marker",
      `${mode}: an explicit FAIL marker is a decisive rejection, not an ambiguous error`
    );
    assert.equal(r.passed, false);
  }
});
