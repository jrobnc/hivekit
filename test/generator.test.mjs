// Tests for the improve-mode majority-failure guard.
//
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkImproveFailures } from "../dist/generator.js";

test("checkImproveFailures — no failures does not throw", () => {
  const merged = [
    "# Agent 1\n\nReal progress here.",
    "# Agent 2\n\nMore progress.",
  ];
  assert.doesNotThrow(() => checkImproveFailures(merged, 2));
});

test("checkImproveFailures — minority failure does not throw", () => {
  const merged = [
    "# Agent 1\n\nReal progress here.",
    "# Agent 2\n\n_No progress recorded._",
    "# Agent 3\n\nMore progress.",
  ];
  assert.doesNotThrow(() => checkImproveFailures(merged, 3));
});

test("checkImproveFailures — majority failure throws", () => {
  const merged = [
    "# Agent 1\n\n_No progress recorded._",
    "# Agent 2\n\n_No progress recorded._",
    "# Agent 3\n\nReal progress.",
  ];
  assert.throws(
    () => checkImproveFailures(merged, 3),
    /Majority of improve agents failed/
  );
});

test("checkImproveFailures — all failures throws", () => {
  const merged = [
    "# Agent 1\n\n_No progress recorded._",
    "# Agent 2\n\n_No progress recorded._",
  ];
  assert.throws(
    () => checkImproveFailures(merged, 2),
    /2\/2 produced no progress/
  );
});

test("checkImproveFailures — majority without notes but a changed working tree does NOT throw", () => {
  // The 2026-10-04 false aborts: agents edited the target but their progress notes were refused under .claude/.
  const merged = ["# Agent 1\n\n_No progress recorded._", "# Agent 2\n\n_No progress recorded._", "# Agent 3\n\nDid X"];
  assert.doesNotThrow(() => checkImproveFailures(merged, 3, true));
  assert.match(checkImproveFailures(merged, 3, true), /working tree changed/, "the downgrade is reported, not silent");
});

test("checkImproveFailures — majority without notes and an unchanged tree still throws", () => {
  const merged = ["# Agent 1\n\n_No progress recorded._", "# Agent 2\n\n_No progress recorded._", "# Agent 3\n\nDid X"];
  assert.throws(() => checkImproveFailures(merged, 3, false), /working tree is unchanged/);
});
