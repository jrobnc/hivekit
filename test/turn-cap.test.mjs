// A max-turns stop must name the phase, and the ledger line must be written even though the SDK throws.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ledger = join(mkdtempSync(join(tmpdir(), "hivekit-turncap-")), "ledger.jsonl");
process.env.HIVEKIT_LEDGER = ledger; // LEDGER is fixed at load, so set before the import

const SDK_ERROR = "Claude Code returned an error result: Reached maximum number of turns (5)";
mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: async function* () {
      yield { type: "result", subtype: "error_max_turns", is_error: true, total_cost_usd: 0.02 };
      throw new Error(SDK_ERROR);
    },
  },
});
const { runAgent } = await import("../dist/sdk-utils.js");

test("planner cap-hit throws a named error and still writes the ledger line", async () => {
  await assert.rejects(
    runAgent({ prompt: "x", label: "planner", phase: "planner", maxTurns: 5, specPaths: 12 }),
    (err) => /planner hit its turn cap \(5 turns\)/.test(err.message) && /12 file path/.test(err.message)
  );
  const last = JSON.parse(readFileSync(ledger, "utf-8").trim().split("\n").pop());
  assert.equal(last.maxTurns, 5);
  assert.equal(last.error, true);
  assert.equal(last.phase, "planner");
  assert.equal(last.turns, 0);
});

test("advisor phase rethrows the original SDK error, not a cap message", async () => {
  await assert.rejects(runAgent({ prompt: "x", label: "a", phase: "advisor", maxTurns: 5 }), { message: SDK_ERROR });
});

test("without a phase the original error is rethrown unchanged", async () => {
  await assert.rejects(runAgent({ prompt: "x", label: "t", maxTurns: 5 }), { message: SDK_ERROR });
});
