// Tests for the improve-mode majority-failure guard.
//
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkImproveFailures, readFindings } from "../dist/generator.js";

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

test("readFindings — missing file is FAILED-TO-REVIEW, not a clean zero", async () => {
  const out = await readFindings("/nonexistent/findings.json", "security", "r1");
  assert.deepEqual(out.findings, []);
  assert.match(out.error, /unreadable/);
});

test("readFindings — invalid JSON sets error; valid file does not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hivekit-findings-"));
  try {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    assert.ok((await readFindings(bad, "security", "r1")).error);

    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ findings: [{ title: "x" }] }));
    const out = await readFindings(good, "security", "r1");
    assert.equal(out.findings.length, 1);
    assert.equal(out.error, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
