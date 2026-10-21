// Every runAgent ledger line carries run, phase, turns, token usage and lane.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ledger = join(mkdtempSync(join(tmpdir(), "hivekit-ledger-")), "ledger.jsonl");
process.env.HIVEKIT_LEDGER = ledger; // LEDGER is fixed at load, so set before the import

mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: async function* ({ prompt }) {
      const base = { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.01 };
      if (prompt === "full") {
        yield {
          ...base,
          num_turns: 7,
          usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
        };
      } else {
        yield base;
      }
    },
  },
});
const { runAgent } = await import("../dist/sdk-utils.js");
const lastLine = () => JSON.parse(readFileSync(ledger, "utf-8").trim().split("\n").pop());

test("ledger line records runId, phase, turns, usage and lane alongside the original keys", async () => {
  process.env.HIVEKIT_LANE = "lane-a";
  try {
    await runAgent({ prompt: "full", label: "review-x", runId: "r1", phase: "review", maxTurns: 3 });
  } finally {
    delete process.env.HIVEKIT_LANE;
  }
  const line = lastLine();
  assert.equal(line.runId, "r1");
  assert.equal(line.phase, "review");
  assert.equal(line.turns, 7);
  assert.deepEqual(line.usage, {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 40,
  });
  assert.equal(line.lane, "lane-a");
  assert.equal(line.label, "review-x");
  assert.equal(line.usd, 0.01);
  assert.equal(line.maxTurns, 3);
  assert.equal(line.error, false);
});

test("missing runId, phase, lane, turns and usage default to empty/zero", async () => {
  delete process.env.HIVEKIT_LANE;
  await runAgent({ prompt: "bare", label: "t" });
  const line = lastLine();
  assert.equal(line.runId, "");
  assert.equal(line.phase, "");
  assert.equal(line.turns, 0);
  assert.deepEqual(line.usage, {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
  assert.equal(line.lane, "");
});

test("ledger line keys are today's keys plus provider; default role is claude sonnet", async () => {
  await runAgent({ prompt: "bare", label: "t", cwd: "/tmp" }); // cwd undefined would drop the key from JSON
  const line = lastLine();
  assert.equal(line.provider, "claude");
  // design change (self-escalating tiers): no role falls back to build/sonnet, was plan/opus
  assert.equal(line.model, "sonnet");
  assert.deepEqual(
    Object.keys(line).sort(),
    "ts,label,model,provider,effort,usd,ms,cwd,maxTurns,error,runId,phase,turns,usage,lane".split(",").sort()
  );
});

test("escalated roles resolve to opus (build) and fable (advise)", async () => {
  await runAgent({ prompt: "bare", label: "t", role: "build-escalated" });
  assert.equal(lastLine().model, "opus");
  await runAgent({ prompt: "bare", label: "t", role: "advise-escalated" });
  assert.equal(lastLine().model, "fable");
});

test("role advise resolves to opus; model overrides on claude", async () => {
  await runAgent({ prompt: "bare", label: "t", role: "advise" });
  // design change (self-escalating tiers): the default advisor is opus, was fable
  assert.equal(lastLine().model, "opus");
  await runAgent({ prompt: "bare", label: "t", model: "x" });
  assert.equal(lastLine().model, "x");
});
