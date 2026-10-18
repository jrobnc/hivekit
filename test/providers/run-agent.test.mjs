import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { startFakeOpenAI, reply, toolCall } from "../helpers/fake-openai.mjs";

const queryCalls = [];
mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: { query: (...a) => { queryCalls.push(a); return (async function* () {})(); } },
});
const dir = mkdtempSync(join(tmpdir(), "hivekit-runagent-"));
const ledger = join(dir, "ledger.jsonl");
process.env.HIVEKIT_LEDGER = ledger; // LEDGER is fixed at load, so set before the import
const { runAgent, TIERS } = await import("../../dist/sdk-utils.js");
const { turnCapMessage } = await import("../../dist/turns.js");

const config = (url, extra = {}) => {
  const p = join(dir, "cfg.json");
  writeFileSync(p, JSON.stringify({ name: "openai-compatible", baseUrl: url, models: { frontier: "big-model", workhorse: "small-model" }, ...extra }));
  return p;
};
async function withProvider(cfgPath, fn) {
  process.env.HIVEKIT_PROVIDER = "openai-compatible";
  process.env.HIVEKIT_PROVIDER_CONFIG = cfgPath;
  try { return await fn(); } finally { delete process.env.HIVEKIT_PROVIDER; delete process.env.HIVEKIT_PROVIDER_CONFIG; }
}

test("runAgent on openai-compatible records provider and workhorse model", async () => {
  const srv = await startFakeOpenAI(() => reply({ role: "assistant", content: "hello" }));
  try {
    const r = await withProvider(config(srv.url), () => runAgent({ ...TIERS.build, prompt: "p", label: "t" }));
    assert.equal(r.result, "hello");
    const line = JSON.parse(readFileSync(ledger, "utf-8").trim().split("\n").pop());
    assert.equal(line.provider, "openai-compatible");
    assert.equal(line.model, "small-model");
    assert.equal(srv.requests[0].body.model, "small-model");
  } finally { await srv.close(); }
});

test("turn cap on openai-compatible throws the named cap message", async () => {
  const srv = await startFakeOpenAI(() => reply(toolCall("Read", { file_path: "/nonexistent" })));
  try {
    await assert.rejects(
      withProvider(config(srv.url), () =>
        runAgent({ ...TIERS.build, prompt: "p", label: "t", phase: "generator", maxTurns: 1, allowedTools: ["Read"] })),
      { message: turnCapMessage("generator", 1) }
    );
  } finally { await srv.close(); }
});

test("bad provider config stops the run before any phase", () => {
  const bad = join(dir, "invalid.json");
  writeFileSync(bad, JSON.stringify({ name: "openai-compatible", baseUrl: "http://x", models: { frontier: "a" } }));
  for (const [cfg, needle] of [["/nonexistent/cfg.json", "/nonexistent/cfg.json"], [bad, "workhorse"]]) {
    const r = spawnSync("node", ["dist/index.js", "task", "--cwd", dir], {
      encoding: "utf-8",
      env: { ...process.env, HIVEKIT_PROVIDER: "openai-compatible", HIVEKIT_PROVIDER_CONFIG: cfg },
    });
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes(needle), r.stderr);
    assert.ok(!r.stdout.includes("Phase 1"));
  }
});

test("a failing openai-compatible provider never falls back to the Claude SDK", async () => {
  const srv = await startFakeOpenAI(() => ({ status: 500, text: "boom" }));
  try {
    await assert.rejects(withProvider(config(srv.url), () => runAgent({ ...TIERS.build, prompt: "p" })), /openai-compatible.*500/);
  } finally { await srv.close(); }
  assert.equal(queryCalls.length, 0);
  const closed = await startFakeOpenAI(() => reply({ role: "assistant", content: "x" }));
  const deadUrl = closed.url;
  await closed.close();
  await assert.rejects(withProvider(config(deadUrl), () => runAgent({ ...TIERS.build, prompt: "p" })), /openai-compatible/);
  assert.equal(queryCalls.length, 0);
});

test("finish_reason length is a failure, not a result", async () => {
  const srv = await startFakeOpenAI(() => ({ choices: [{ message: { role: "assistant", content: "partial" }, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  try {
    await assert.rejects(
      withProvider(config(srv.url), () => runAgent({ ...TIERS.build, prompt: "p", label: "t" })),
      /Agent failed \(finish_length\): partial/
    );
  } finally { await srv.close(); }
});

test("budget stop after a tool turn names its subtype", async () => {
  const srv = await startFakeOpenAI(() => reply(toolCall("Read", { file_path: "x" })));
  const price = { input: 1e6, output: 1e6 };
  process.env.HIVEKIT_MAX_USD_PER_AGENT = "0.01";
  try {
    await assert.rejects(
      withProvider(config(srv.url, { pricesUsdPerMTok: { "big-model": price, "small-model": price } }), () =>
        runAgent({ ...TIERS.build, allowedTools: ["Read"], prompt: "p" })),
      /Agent failed \(error_max_budget_usd\)/
    );
  } finally { delete process.env.HIVEKIT_MAX_USD_PER_AGENT; await srv.close(); }
});

test("H1: an error after turn 1 still ledgers the earlier turn's spend", async () => {
  const srv = await startFakeOpenAI((_b, i) =>
    i === 0 ? reply(toolCall("Read", { file_path: "x" }), { prompt_tokens: 10, completion_tokens: 3 }) : { status: 500, text: "boom" });
  try {
    await assert.rejects(
      withProvider(config(srv.url), () => runAgent({ ...TIERS.build, allowedTools: ["Read"], label: "h1", prompt: "p" })),
      /500: boom/
    );
    const line = JSON.parse(readFileSync(ledger, "utf-8").trim().split("\n").pop());
    assert.equal(line.turns, 1);
    assert.equal(line.usage.input_tokens, 10);
    assert.equal(line.error, true);
  } finally { await srv.close(); }
});

test("H2: a budget cap with an unpriced model is rejected before any request", async () => {
  const srv = await startFakeOpenAI(() => reply({ role: "assistant", content: "hi" }));
  process.env.HIVEKIT_MAX_USD_PER_AGENT = "2";
  try {
    await assert.rejects(
      withProvider(config(srv.url), () => runAgent({ ...TIERS.build, prompt: "p", label: "h2" })),
      (e) => /HIVEKIT_MAX_USD_PER_AGENT/.test(e.message) && /small-model|big-model/.test(e.message)
    );
    assert.equal(srv.requests.length, 0);
  } finally { delete process.env.HIVEKIT_MAX_USD_PER_AGENT; await srv.close(); }
});
