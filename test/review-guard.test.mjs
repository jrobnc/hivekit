// Regression test: review-mode "majority failed" guard counts genuinely empty dimensions, not errored ones.
// Own file because mock.module must run before the import.
//
// Requires: node --experimental-test-module-mocks (npm test sets it)
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let runAgentImpl = async () => {};
mock.module("../dist/sdk-utils.js", {
  namedExports: {
    runAgent: (...args) => runAgentImpl(...args),
    // The prompt becomes the findings path so the fake agent knows where to write.
    fillTemplate: (_t, vars) => vars.findingsPath,
    loadPrinciples: async () => "",
    TIERS: { review: { model: "sonnet", effort: "medium" } },
  },
});

const { runGenerator } = await import("../dist/generator.js");

function makeCtx() {
  const dir = mkdtempSync(join(tmpdir(), "hivekit-review-guard-"));
  return { runId: "r", runDir: dir, indexPath: "", config: { mode: "review", depth: "quick", cwd: dir, task: "t" } };
}

test("review guard — all dimensions errored (unreadable findings) resolves with error flags", async () => {
  runAgentImpl = async () => {};
  const out = await runGenerator(makeCtx());
  assert.equal(out.findings.filter(f => f.error).length, 3);
});

test("review guard — majority genuinely empty findings still aborts", async () => {
  runAgentImpl = async ({ prompt }) => writeFileSync(prompt, '{"findings":[]}');
  await assert.rejects(runGenerator(makeCtx()), /Majority of review agents failed/);
});
