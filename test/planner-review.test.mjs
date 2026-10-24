// Review planner: a read-only agent that returns nothing must fail once, not be told to Write.
// Separate file: the sdk-utils mock must be registered before planner.js is imported.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runDir = mkdtempSync(join(tmpdir(), "planner-review-"));
let calls = 0;
mock.module("../dist/sdk-utils.js", { namedExports: {
  runAgent: async () => { calls++; return { durationMs: 0, result: "  " }; },
  fillTemplate: (t) => t,
  loadPrinciples: async () => "",
  TIERS: { plan: { role: "plan", effort: "medium" } },
}});
const { runPlanner } = await import("../dist/planner.js");

test("review mode with an empty first result rejects without a retry", async () => {
  const ctx = { config: { mode: "review", cwd: runDir, depth: "standard", task: "t" }, runDir, runId: "test" };
  await assert.rejects(runPlanner(ctx), /Review planner returned no spec text .*Workaround: --plan <path>\./);
  assert.equal(calls, 1);
});
