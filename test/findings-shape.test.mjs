import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFindings } from "../dist/generator.js";

// Regression: a review agent wrote architecture.json as a bare array; reading `.findings.length`
// crashed the run ("Cannot read properties of undefined (reading 'length')") after all seven
// specialists had finished.
test("a bare array becomes the findings list", () => {
  const out = normalizeFindings([{ title: "x" }, { title: "y" }], "architecture", "run-1");
  assert.equal(out.dimension, "architecture");
  assert.equal(out.runId, "run-1");
  assert.equal(out.findings.length, 2);
});

test("the documented { findings: [...] } shape is kept as written", () => {
  const out = normalizeFindings({ dimension: "bugs", agent: "Agent: bugs", runId: "r", findings: [{ title: "z" }] }, "bugs", "r");
  assert.equal(out.agent, "Agent: bugs");
  assert.equal(out.findings.length, 1);
});

test("any other shape becomes an empty dimension, never an exception", () => {
  for (const bad of [null, 42, "text", { findings: "nope" }, { notFindings: [] }]) {
    const out = normalizeFindings(bad, "ux", "r");
    assert.deepEqual(out.findings, [], `shape ${JSON.stringify(bad)}`);
  }
});
