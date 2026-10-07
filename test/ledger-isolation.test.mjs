// The test suite must never write to the real cost ledger (~/.cache/hivekit/ledger.jsonl):
// npm test sets HIVEKIT_LEDGER to a throwaway file, and sdk-utils honours it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

test("tests run against a throwaway ledger, not the real one", async () => {
  assert.ok(process.env.HIVEKIT_LEDGER, "npm test must set HIVEKIT_LEDGER");
  const { LEDGER } = await import("../dist/sdk-utils.js");
  assert.equal(LEDGER, process.env.HIVEKIT_LEDGER);
  assert.notEqual(LEDGER, join(homedir(), ".cache", "hivekit", "ledger.jsonl"));
});
