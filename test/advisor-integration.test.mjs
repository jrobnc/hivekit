// Tests for advisor checkpoint wiring in the orchestrator (src/index.ts).
//
// Mocks every side-effectful module (planner, generator, evaluator, advisor,
// sdk-utils) so main() runs entirely offline, then asserts on outcomes, file
// artifacts, and feedback flow.
//
// Requires: node --experimental-test-module-mocks
// Run: npm test

import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Controllable stubs ─────────────────────────────────────────────

let adviseImpl = async () => ({ ok: true, note: "advisor ok" });
let jevYesNoImpl = async () => null;
let evaluatorResults = [];
let generatorFeedbacks = [];
let tmpDir;

// ── Module mocks ───────────────────────────────────────────────────

mock.module("../dist/advisor.js", {
  namedExports: {
    advise: (...args) => adviseImpl(...args),
    jevYesNo: (...args) => jevYesNoImpl(...args),
  },
});

mock.module("../dist/planner.js", {
  namedExports: {
    runPlanner: async (ctx) => {
      const planPath = join(ctx.runDir, "plan.md");
      writeFileSync(planPath, "# Test plan\n", "utf-8");
      return { planPath, planContent: "# Test plan" };
    },
  },
});

mock.module("../dist/generator.js", {
  namedExports: {
    runGenerator: async (_ctx, feedback) => {
      generatorFeedbacks.push(feedback);
      return { mode: "build" };
    },
  },
});

mock.module("../dist/evaluator.js", {
  namedExports: {
    runEvaluator: async (_ctx, round) => {
      const idx = round - 1;
      return evaluatorResults[idx] ?? {
        scores: [{ criterion: "test", score: 80 }],
        status: "passed",
        reason: "meets_threshold",
        passed: true,
        feedback: "",
        report: "All good",
      };
    },
  },
});

// Stub sdk-utils to avoid real agent calls (imported transitively by advisor)
mock.module("../dist/sdk-utils.js", {
  namedExports: {
    runAgent: async () => "stubbed",
    TIERS: { opus: "claude-sonnet-4-20250514", sonnet: "claude-sonnet-4-20250514", fable: "claude-sonnet-4-20250514" },
    appendLedger: async () => {},
  },
});

const { main } = await import("../dist/index.js");

// index.ts sets process.exitCode = 1 as a fail-closed default. Reset it so
// the test runner doesn't interpret that as a suite failure.
process.exitCode = 0;

// ── Helpers ────────────────────────────────────────────────────────

function setupTmpDir() {
  tmpDir = mkdtempSync(join(tmpdir(), "hivekit-advisor-test-"));
  mkdirSync(join(tmpDir, ".hivekit", "runs"), { recursive: true });
}

function setArgv(mode = "build") {
  process.argv = ["node", "index.js", "test task", "--mode", mode, "--cwd", tmpDir];
}

function findRunDir() {
  const runsDir = join(tmpDir, ".hivekit", "runs");
  const entries = readdirSync(runsDir).filter(e => e !== "index.md" && !e.startsWith("."));
  return entries.length > 0 ? join(runsDir, entries[entries.length - 1]) : null;
}

// ── Tests ──────────────────────────────────────────────────────────

test("plan objection becomes round-1 generator feedback", async () => {
  setupTmpDir();
  setArgv();
  adviseImpl = async (checkpoint) => {
    if (checkpoint === "plan") return { ok: false, note: "OBJECTION\nPlan misses auth constraints" };
    return { ok: true, note: "ok" };
  };
  evaluatorResults = [
    { scores: [{ criterion: "test", score: 90 }], status: "passed", reason: "meets_threshold", passed: true, feedback: "", report: "ok" },
  ];
  generatorFeedbacks = [];

  const outcome = await main();

  // Generator should have received the plan objection as feedback
  assert.ok(generatorFeedbacks[0]?.includes("Advisor objection to the plan"),
    `Expected plan objection in generator feedback, got: ${generatorFeedbacks[0]}`);
  assert.ok(generatorFeedbacks[0]?.includes("Plan misses auth constraints"));

  // advisor-plan.md should exist
  const runDir = findRunDir();
  assert.ok(existsSync(join(runDir, "advisor-plan.md")), "advisor-plan.md should be written");

  rmSync(tmpDir, { recursive: true, force: true });
});

test("done objection with rounds left triggers another round", async () => {
  setupTmpDir();
  setArgv();
  let doneCallCount = 0;
  adviseImpl = async (checkpoint) => {
    if (checkpoint === "done") {
      doneCallCount++;
      // First done check: objection. Second: ok
      return doneCallCount === 1
        ? { ok: false, note: "OBJECTION\nTests were skipped" }
        : { ok: true, note: "verified" };
    }
    return { ok: true, note: "ok" };
  };
  evaluatorResults = [
    { scores: [{ criterion: "test", score: 90 }], status: "passed", reason: "meets_threshold", passed: true, feedback: "", report: "ok" },
    { scores: [{ criterion: "test", score: 95 }], status: "passed", reason: "meets_threshold", passed: true, feedback: "", report: "better" },
  ];
  generatorFeedbacks = [];

  const outcome = await main();

  // Should have run 2 generator rounds (objection on first pass → retry)
  assert.equal(generatorFeedbacks.length, 2);
  assert.ok(generatorFeedbacks[1]?.includes("advisor found skipped"),
    `Expected advisor feedback in round 2, got: ${generatorFeedbacks[1]}`);
  assert.equal(outcome, "passed");

  const runDir = findRunDir();
  assert.ok(existsSync(join(runDir, "advisor-done-r1.md")));

  rmSync(tmpDir, { recursive: true, force: true });
});

test("done objection on last round fails through outcome model (exit 2)", async () => {
  setupTmpDir();
  setArgv();
  adviseImpl = async (checkpoint) => {
    if (checkpoint === "done") return { ok: false, note: "OBJECTION\nCritical tests missing" };
    return { ok: true, note: "ok" };
  };
  // All 3 rounds pass but advisor objects every time
  evaluatorResults = [
    { scores: [{ criterion: "test", score: 90 }], status: "passed", reason: "meets_threshold", passed: true, feedback: "", report: "ok" },
    { scores: [{ criterion: "test", score: 90 }], status: "passed", reason: "meets_threshold", passed: true, feedback: "", report: "ok" },
    { scores: [{ criterion: "test", score: 90 }], status: "passed", reason: "meets_threshold", passed: true, feedback: "", report: "ok" },
  ];
  generatorFeedbacks = [];

  const outcome = await main();

  assert.equal(outcome, "failed", "Advisor objection on last round must produce 'failed' outcome");

  // result.json should contain the error
  const runDir = findRunDir();
  const result = JSON.parse(readFileSync(join(runDir, "result.json"), "utf-8"));
  assert.ok(result.error?.includes("Advisor objection"), `Expected advisor objection in error, got: ${result.error}`);
  assert.equal(result.exitCode, 2);

  rmSync(tmpDir, { recursive: true, force: true });
});

test("advisor unavailable (ok: true) does not affect outcome", async () => {
  setupTmpDir();
  setArgv();
  adviseImpl = async () => ({ ok: true, note: "advisor unavailable: no ANTHROPIC_API_KEY" });
  evaluatorResults = [
    { scores: [{ criterion: "test", score: 90 }], status: "passed", reason: "meets_threshold", passed: true, feedback: "", report: "ok" },
  ];
  generatorFeedbacks = [];

  const outcome = await main();

  assert.equal(outcome, "passed", "Advisor unavailable must not block a pass");
  // Generator feedback should NOT contain objection text
  assert.ok(!generatorFeedbacks[0]?.includes("Advisor objection"),
    "No objection feedback when advisor is unavailable");

  rmSync(tmpDir, { recursive: true, force: true });
});

test("HIVEKIT_ADVISOR=0 skips all advisor and jev calls", async () => {
  setupTmpDir();
  setArgv();
  process.env.HIVEKIT_ADVISOR = "0";
  adviseImpl = async () => { throw new Error("advise should not be called"); };
  jevYesNoImpl = async () => { throw new Error("jevYesNo should not be called"); };
  evaluatorResults = [
    { scores: [{ criterion: "test", score: 90 }], status: "passed", reason: "meets_threshold", passed: true, feedback: "", report: "ok" },
  ];

  const outcome = await main();

  assert.equal(outcome, "passed");
  delete process.env.HIVEKIT_ADVISOR;

  rmSync(tmpDir, { recursive: true, force: true });
});

test("review mode skips all advisor and jev calls", async () => {
  setupTmpDir();
  setArgv("review");
  adviseImpl = async () => { throw new Error("advise should not be called in review mode"); };
  jevYesNoImpl = async () => { throw new Error("jevYesNo should not be called in review mode"); };
  evaluatorResults = [
    { scores: [{ criterion: "test", score: 90 }], status: "passed", reason: "meets_threshold", passed: true, feedback: "", report: "review done" },
  ];

  const outcome = await main();

  assert.equal(outcome, "review_completed");

  rmSync(tmpDir, { recursive: true, force: true });
});

test("stuck: jev true/null escalates to advisor; jev false skips", async () => {
  setupTmpDir();
  setArgv();

  let stuckAdvised = false;
  adviseImpl = async (checkpoint) => {
    if (checkpoint === "stuck") {
      stuckAdvised = true;
      return { ok: true, note: "Try a different approach: use X instead of Y" };
    }
    return { ok: true, note: "ok" };
  };

  // jev returns true (same failure) → should escalate to advisor
  jevYesNoImpl = async () => true;

  evaluatorResults = [
    { scores: [{ criterion: "test", score: 40 }], status: "failed", reason: "below_threshold", passed: false, feedback: "Build error in auth.ts", report: "fail" },
    { scores: [{ criterion: "test", score: 45 }], status: "failed", reason: "below_threshold", passed: false, feedback: "Build error in auth.ts", report: "fail" },
    { scores: [{ criterion: "test", score: 90 }], status: "passed", reason: "meets_threshold", passed: true, feedback: "", report: "ok" },
  ];
  generatorFeedbacks = [];

  const outcome = await main();

  assert.ok(stuckAdvised, "advise('stuck') should have been called when jev returns true");
  // Round 3 feedback should include advisor note
  assert.ok(generatorFeedbacks[2]?.includes("Advisor on the repeated failure"),
    `Expected stuck advisor feedback in round 3, got: ${generatorFeedbacks[2]}`);

  const runDir = findRunDir();
  assert.ok(existsSync(join(runDir, "advisor-stuck-r2.md")), "advisor-stuck-r2.md should exist");

  // Now test jev false → should NOT call advise("stuck")
  rmSync(tmpDir, { recursive: true, force: true });
  setupTmpDir();
  setArgv();
  stuckAdvised = false;
  jevYesNoImpl = async () => false; // different failure → skip advisor

  evaluatorResults = [
    { scores: [{ criterion: "test", score: 40 }], status: "failed", reason: "below_threshold", passed: false, feedback: "Build error", report: "fail" },
    { scores: [{ criterion: "test", score: 45 }], status: "failed", reason: "below_threshold", passed: false, feedback: "Different error", report: "fail" },
    { scores: [{ criterion: "test", score: 90 }], status: "passed", reason: "meets_threshold", passed: true, feedback: "", report: "ok" },
  ];
  generatorFeedbacks = [];

  await main();

  assert.ok(!stuckAdvised, "advise('stuck') should NOT be called when jev returns false");

  rmSync(tmpDir, { recursive: true, force: true });
});
