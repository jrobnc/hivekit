// The cost ledger is bookkeeping: an unwritable ~/.cache must never crash a run, and a typo in a
// spend-cap env var must never disable the cap (Number("abc") is NaN; spent >= NaN is always false).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HOME/.cache is a FILE, so mkdir(~/.cache/hivekit) fails. Set before sdk-utils loads (LEDGER is fixed at load).
const home = mkdtempSync(join(tmpdir(), "hivekit-ledger-"));
writeFileSync(join(home, ".cache"), "not a directory");
process.env.HOME = home;

mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.01 };
    },
  },
});
const { runAgent, positiveNumber } = await import("../dist/sdk-utils.js");

test("an unwritable ledger does not crash runAgent", async () => {
  const out = await runAgent({ prompt: "x", label: "t", cwd: home, maxTurns: 1 });
  assert.equal(out.result, "done");
});

test("positiveNumber never lets a typo through as NaN", () => {
  assert.equal(positiveNumber(undefined), undefined);
  assert.equal(positiveNumber(""), undefined);
  assert.equal(positiveNumber("abc"), undefined);
  assert.equal(positiveNumber("-5"), undefined);
  assert.equal(positiveNumber("0"), undefined);
  assert.equal(positiveNumber("2.5"), 2.5);
});
