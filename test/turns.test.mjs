import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTurnLimits, countSpecPaths, turnCapMessage } from "../dist/turns.js";

const paths = (n) => Array.from({ length: n }, (_, i) => `src/f${i}.ts`).join(" ");
const all = (l, n) => [l.planner, l.generator, l.evaluator, l.review].every((v) => v === n);

test("defaults", () => {
  const b = resolveTurnLimits({ task: paths(15), mode: "build" }, {});
  assert.deepEqual([b.planner, b.generator, b.evaluator, b.review], [75, 100, 40, 40]);
  assert.equal(resolveTurnLimits({ task: "x", mode: "improve" }, {}).generator, 60);
});

test("precedence: CLI per-phase > CLI max > env per-phase > env max > default", () => {
  const task = "make it faster";
  assert.ok(all(resolveTurnLimits({ task, mode: "build" }, { HIVEKIT_MAX_TURNS: "80" }), 80));
  const c = resolveTurnLimits({ task, mode: "build" }, { HIVEKIT_PLANNER_TURNS: "90", HIVEKIT_MAX_TURNS: "80" });
  assert.deepEqual([c.planner, c.generator, c.evaluator, c.review], [90, 80, 80, 80]);
  const d = resolveTurnLimits({ task, mode: "build", maxTurns: 50 }, { HIVEKIT_PLANNER_TURNS: "90", HIVEKIT_MAX_TURNS: "80" });
  assert.ok(all(d, 50));
  const e = resolveTurnLimits({ task, mode: "build", maxTurns: 50, turns: { planner: 120 } }, {});
  assert.deepEqual([e.planner, e.generator], [120, 50]);
});

test("invalid env values are ignored", () => {
  for (const bad of ["abc", "0", "-3"]) {
    const l = resolveTurnLimits({ task: "x", mode: "build" }, { HIVEKIT_MAX_TURNS: bad, HIVEKIT_PLANNER_TURNS: bad });
    assert.deepEqual([l.planner, l.generator], [60, 100]);
  }
});

test("planner default scales with spec paths, capped; explicit is uncapped", () => {
  assert.equal(resolveTurnLimits({ task: paths(15), mode: "build" }, {}).planner, 75);
  assert.equal(resolveTurnLimits({ task: paths(200), mode: "build" }, {}).planner, 150);
  assert.equal(resolveTurnLimits({ task: "x", mode: "build", turns: { planner: 200 } }, {}).planner, 200);
});

test("countSpecPaths", () => {
  assert.equal(countSpecPaths("edit src/planner.ts and src/index.ts, then README.md"), 3);
  assert.equal(countSpecPaths("src/a.ts src/a.ts:12"), 1);
  assert.equal(countSpecPaths("bin/hivekit"), 1);
  assert.equal(countSpecPaths("see https://example.com/a/b.html"), 0);
  assert.equal(countSpecPaths("version 0.3.292"), 0);
  assert.equal(countSpecPaths("make it faster"), 0);
});

test("turnCapMessage", () => {
  const m = turnCapMessage("planner", 60, 15);
  for (const s of ["planner", "(60 turns)", "--planner-turns", "HIVEKIT_PLANNER_TURNS", "--max-turns", "15 file path"]) {
    assert.ok(m.includes(s), s);
  }
  const r = turnCapMessage("review", 40);
  assert.ok(r.includes("--review-turns"));
  assert.ok(!r.includes("file path"));
});
