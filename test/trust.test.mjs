// The trust boundary: which tools each agent gets per mode (real policy, stubbed runAgent only),
// the review-mode artifact fallbacks, and the opt-in warning.
//
// Requires: node --experimental-test-module-mocks (npm test sets it)
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const calls = [];
let reply = "";
mock.module("../dist/sdk-utils.js", {
  namedExports: {
    runAgent: async (o) => {
      calls.push({ label: o.label, allowedTools: o.allowedTools });
      return { result: reply, durationMs: 0 };
    },
    appendLedger: async () => {},
    fillTemplate: () => "prompt",
    loadPrinciples: async () => "",
    positiveNumber: (_v, d) => d,
    LEDGER: join(tmpdir(), "hivekit-trust-test-ledger.jsonl"),
    TIERS: {
      plan: { role: "plan", effort: "high" },
      build: { role: "build", effort: "medium" },
      review: { role: "review", effort: "medium" },
      evaluate: { role: "evaluate", effort: "high" },
      advise: { role: "advise", effort: "high" },
      buildEscalated: { role: "build-escalated", effort: "medium" },
      adviseEscalated: { role: "advise-escalated", effort: "high" },
    },
  },
});

const { runPlanner } = await import("../dist/planner.js");
const { runGenerator } = await import("../dist/generator.js");
const { runEvaluator } = await import("../dist/evaluator.js");
const { advise } = await import("../dist/advisor.js");
const { reviewBashWarning, toolsFor } = await import("../dist/trust.js");

const RO = ["Read", "Glob", "Grep"];
const ROB = [...RO, "Bash"];

function makeCtx(mode) {
  const dir = mkdtempSync(join(tmpdir(), "hivekit-trust-"));
  return {
    runId: "r", runDir: dir, indexPath: "",
    config: { mode, depth: "quick", cwd: dir, task: "t", maxEvalRounds: 3, evalThreshold: 80 },
  };
}

const FINDINGS = JSON.stringify({
  dimension: "x", agent: "a", runId: "r",
  findings: [{ severity: "high", file: "f.ts", line: 1, title: "t", detail: "d", suggestion: "s", confidence: 90 }],
});

async function collect(mode) {
  calls.length = 0;
  reply = FINDINGS; // a plan/findings-shaped reply so every agent completes
  const ctx = makeCtx(mode);
  // Build/improve planners have no text fallback (unchanged): the stub writes no plan.md, so they throw after the retry.
  await runPlanner(ctx).catch((e) => assert.notEqual(mode, "review", e.message));
  if (mode === "review") await runGenerator(ctx);
  await runEvaluator(ctx, 1);
  await advise("plan", ctx.config.cwd, "ctx", "r", false, mode);
  const by = (prefix) => calls.filter((c) => c.label.startsWith(prefix)).map((c) => c.allowedTools);
  return { planner: by("planner"), review: by("review-"), evaluator: by("evaluator"), advisor: by("advisor") };
}

test("review mode: every agent is read-only", async () => {
  delete process.env.HIVEKIT_REVIEW_ALLOW_BASH;
  const t = await collect("review");
  assert.ok(t.review.length > 0);
  for (const list of [...t.planner, ...t.review, ...t.evaluator, ...t.advisor]) assert.deepEqual(list, RO);
});

test("review mode + HIVEKIT_REVIEW_ALLOW_BASH=1: Bash for all but the evaluator", async (t) => {
  process.env.HIVEKIT_REVIEW_ALLOW_BASH = "1";
  t.after(() => delete process.env.HIVEKIT_REVIEW_ALLOW_BASH);
  const r = await collect("review");
  for (const list of [...r.planner, ...r.review, ...r.advisor]) assert.deepEqual(list, ROB);
  for (const list of r.evaluator) assert.deepEqual(list, RO);
});

test("build and improve: planner/advisor unchanged, evaluator read-only", async () => {
  for (const mode of ["build", "improve"]) {
    const r = await collect(mode);
    assert.deepEqual(r.planner[0], ["Read", "Glob", "Grep", "Bash", "Write"]);
    assert.deepEqual(r.advisor[0], ["Read", "Glob", "Grep", "Bash"]);
    assert.deepEqual(r.evaluator[0], RO);
  }
});

test("toolsFor leaves non-review lists alone", () => {
  const l = ["Read", "Write"];
  assert.equal(toolsFor("build", l), l);
});

test("reviewBashWarning", () => {
  const w = reviewBashWarning("review", { HIVEKIT_REVIEW_ALLOW_BASH: "1" });
  assert.match(w, /^\[hivekit\] WARN:/);
  assert.match(w, /prompt injection/);
  assert.equal(reviewBashWarning("build", { HIVEKIT_REVIEW_ALLOW_BASH: "1" }), undefined);
  assert.equal(reviewBashWarning("review", {}), undefined);
});

test("review generator: findings returned as text are saved and parsed", async () => {
  reply = "Here you go:\n```json\n" + FINDINGS + "\n```";
  const out = await runGenerator(makeCtx("review"));
  assert.ok(out.findings.every((f) => !f.error && f.findings.length === 1));
});

test("review generator: unparseable text is FAILED-TO-REVIEW (fail closed)", async () => {
  reply = "I looked and it seems fine.";
  const out = await runGenerator(makeCtx("review"));
  assert.equal(out.findings.filter((f) => f.error).length, 3);
});

test("review planner: the returned spec is saved to plan.md", async () => {
  reply = "# Review Spec\nscope";
  const ctx = makeCtx("review");
  await runPlanner(ctx);
  assert.equal(readFileSync(join(ctx.runDir, "plan.md"), "utf-8"), "# Review Spec\nscope");
});

// ── reviewChecksBlocked: an intent inside the reviewed tree is untrusted ──
{
  const { mkdirSync, writeFileSync, symlinkSync } = await import("node:fs");
  const { reviewChecksBlocked } = await import("../dist/trust.js");
  const base = mkdtempSync(join(tmpdir(), "hivekit-inside-"));
  const cwd = join(base, "repo");
  const out = join(base, "out");
  mkdirSync(cwd); mkdirSync(out);
  writeFileSync(join(cwd, "HIVE.md"), "x");
  writeFileSync(join(out, "HIVE.md"), "x");
  symlinkSync(join(out, "HIVE.md"), join(cwd, "link.md"));
  symlinkSync(out, join(cwd, "linkdir"));
  mkdirSync(join(cwd, "..notes"));
  writeFileSync(join(cwd, "..notes", "HIVE.md"), "x");
  const blocked = (p, env = {}) => reviewChecksBlocked("review", p, cwd, env);

  test("reviewChecksBlocked: inside the tree is blocked", () => {
    assert.equal(blocked(join(cwd, "HIVE.md")), "intent is inside the reviewed tree");
  });
  test("reviewChecksBlocked: an in-tree dir named `..notes` is inside, not a parent climb", () => {
    assert.equal(blocked(join(cwd, "..notes", "HIVE.md")), "intent is inside the reviewed tree");
  });
  test("reviewChecksBlocked: outside the tree is allowed", () => {
    assert.equal(blocked(join(out, "HIVE.md")), undefined);
  });
  test("reviewChecksBlocked: a symlink inside pointing outside counts as inside", () => {
    assert.ok(blocked(join(cwd, "link.md")));
  });
  test("reviewChecksBlocked: a symlinked dir inside cwd counts as inside", () => {
    assert.ok(blocked(join(cwd, "linkdir", "HIVE.md")));
  });
  test("reviewChecksBlocked: env opt-in, non-review modes and no intent return undefined", () => {
    assert.equal(blocked(join(cwd, "HIVE.md"), { HIVEKIT_REVIEW_ALLOW_BASH: "1" }), undefined);
    assert.equal(reviewChecksBlocked("build", join(cwd, "HIVE.md"), cwd, {}), undefined);
    assert.equal(reviewChecksBlocked("review", undefined, cwd, {}), undefined);
  });
  test("reviewChecksBlocked: a missing path fails closed", () => {
    assert.ok(blocked(join(cwd, "nope.md")));
  });
}
