// runGenerator must spread the caller's tier into every runAgent call (build and improve).
// Separate file: the sdk-utils mock must be registered before generator.js is imported.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runDir = mkdtempSync(join(tmpdir(), "gen-tier-"));
const roles = [];
mock.module("../dist/sdk-utils.js", { namedExports: {
  runAgent: async (opts) => {
    roles.push(opts.role);
    const m = /^improve-(\d+)$/.exec(opts.label ?? "");
    if (m) writeFileSync(join(runDir, `progress-${m[1]}.md`), "did work\n"); // satisfy checkImproveFailures
    return { durationMs: 0 };
  },
  fillTemplate: (t) => t,
  loadPrinciples: async () => "",
  TIERS: { build: { role: "build", effort: "medium" }, review: { role: "review", effort: "medium" },
           buildEscalated: { role: "build-escalated", effort: "medium" } },
}});
const { runGenerator } = await import("../dist/generator.js");

writeFileSync(join(runDir, "plan.md"), "# Plan\n\n### One\nDo the thing.\n");

for (const mode of ["build", "improve"]) {
  test(`runGenerator (${mode}) uses the tier it is given`, async () => {
    roles.length = 0;
    const ctx = { config: { mode, cwd: runDir, depth: "standard", task: "t" }, runDir, runId: "test" };
    await runGenerator(ctx, undefined, { role: "build-escalated", effort: "medium" });
    assert.ok(roles.length > 0 && roles.every((r) => r === "build-escalated"), `roles: ${roles}`);
  });
}
