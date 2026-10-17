import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeOpenAI, reply, toolCall } from "../helpers/fake-openai.mjs";
import { createOpenAICompatibleProvider } from "../../dist/providers/openai-compatible.js";
import { runTool } from "../../dist/providers/tools.js";
import { getProvider } from "../../dist/providers/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "hivekit-oai-"));
const mk = (url, extra = {}) =>
  createOpenAICompatibleProvider({ name: "openai-compatible", baseUrl: url, models: { frontier: "big", workhorse: "small" }, ...extra });
const input = (o = {}) => ({ prompt: "go", model: "small", allowedTools: ["Read", "Write"], permissionMode: "acceptEdits", maxTurns: 5, ...o });

test("tool call → tool result → final answer", async () => {
  const dir = tmp();
  const srv = await startFakeOpenAI((_b, i) =>
    i === 0 ? reply(toolCall("Write", { file_path: "a.txt", content: "hi" }, "c9")) : reply({ role: "assistant", content: "done" })
  );
  try {
    const out = await mk(srv.url).run(input({ cwd: dir }));
    assert.equal(readFileSync(join(dir, "a.txt"), "utf-8"), "hi");
    assert.equal(out.result, "done");
    assert.equal(out.turns, 2);
    assert.ok(srv.requests[1].body.messages.some((m) => m.role === "tool" && m.tool_call_id === "c9"));
    assert.equal(srv.requests[0].url, "/v1/chat/completions");
  } finally { await srv.close(); }
});

test("allowedTools limits the tools offered and executed", async () => {
  const dir = tmp();
  const srv = await startFakeOpenAI((_b, i) =>
    i === 0 ? reply(toolCall("Write", { file_path: "no.txt", content: "x" })) : reply({ role: "assistant", content: "ok" })
  );
  try {
    await mk(srv.url).run(input({ cwd: dir, allowedTools: ["Read"] }));
    assert.deepEqual(srv.requests[0].body.tools.map((t) => t.function.name), ["Read"]);
    assert.equal(existsSync(join(dir, "no.txt")), false);
    const toolMsg = srv.requests[1].body.messages.find((m) => m.role === "tool");
    assert.match(toolMsg.content, /Error: .*not allowed/);
  } finally { await srv.close(); }
});

test("maxTurns yields error_max_turns after exactly maxTurns requests", async () => {
  const srv = await startFakeOpenAI(() => reply(toolCall("Read", { file_path: "/nonexistent" })));
  try {
    const out = await mk(srv.url).run(input({ maxTurns: 2 }));
    assert.equal(out.isError, true);
    assert.equal(out.subtype, "error_max_turns");
    assert.equal(out.turns, 2);
    assert.equal(srv.requests.length, 2);
  } finally { await srv.close(); }
});

test("usage and cost mapping", async () => {
  const srv = await startFakeOpenAI(() => reply({ role: "assistant", content: "x" }, { prompt_tokens: 11, completion_tokens: 7 }));
  try {
    const priced = await mk(srv.url, { pricesUsdPerMTok: { small: { input: 1_000_000, output: 2_000_000 } } }).run(input());
    assert.deepEqual(priced.usage, { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    assert.equal(priced.totalCostUsd, 11 + 14);
    assert.equal((await mk(srv.url).run(input())).totalCostUsd, 0);
  } finally { await srv.close(); }
});

test("auth header only when apiKeyEnv is set; missing env var names the var, not a key", async () => {
  const srv = await startFakeOpenAI(() => reply({ role: "assistant", content: "x" }));
  try {
    await mk(srv.url).run(input());
    assert.equal(srv.requests[0].headers.authorization, undefined);
    process.env.HK_TEST_KEY = "sekret-123";
    await mk(srv.url, { apiKeyEnv: "HK_TEST_KEY" }).run(input());
    assert.equal(srv.requests[1].headers.authorization, "Bearer sekret-123");
    delete process.env.HK_TEST_KEY;
    await assert.rejects(mk(srv.url, { apiKeyEnv: "HK_TEST_KEY" }).run(input()), (e) => {
      assert.match(e.message, /HK_TEST_KEY/);
      assert.doesNotMatch(e.message, /sekret/);
      return true;
    });
  } finally { delete process.env.HK_TEST_KEY; await srv.close(); }
});

test("non-2xx throws with status and at most 200 chars of body", async () => {
  const srv = await startFakeOpenAI(() => ({ status: 500, text: "B".repeat(1000) }));
  try {
    await assert.rejects(mk(srv.url).run(input()), (e) => {
      assert.match(e.message, /500/);
      assert.ok(!e.message.includes("B".repeat(201)));
      return true;
    });
  } finally { await srv.close(); }
});

test("preflight succeeds on 200 and rejects otherwise", async () => {
  const ok = await startFakeOpenAI(() => ({ data: [] }));
  const bad = await startFakeOpenAI(() => ({ status: 401, text: "no" }));
  try {
    await mk(ok.url).preflight();
    await assert.rejects(mk(bad.url).preflight(), /preflight.*401/);
  } finally { await ok.close(); await bad.close(); }
});

test("tools: Read, Write, Edit, Glob, Grep, Bash", async () => {
  const dir = tmp();
  const ctx = { cwd: dir, allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"] };
  const t = (n, a) => runTool(n, JSON.stringify(a), ctx);
  await t("Write", { file_path: "sub/a.txt", content: "one\ntwo\ntwo\n" });
  assert.equal(await t("Read", { file_path: "sub/a.txt", offset: 1, limit: 1 }), "two");
  assert.match(await t("Edit", { file_path: "sub/a.txt", old_string: "two", new_string: "2" }), /not unique/);
  assert.match(await t("Edit", { file_path: "sub/a.txt", old_string: "zzz", new_string: "2" }), /^Error/);
  await t("Edit", { file_path: "sub/a.txt", old_string: "two", new_string: "2", replace_all: true });
  assert.equal(readFileSync(join(dir, "sub/a.txt"), "utf-8"), "one\n2\n2\n");
  assert.equal(await t("Glob", { pattern: "**/*.txt" }), "sub/a.txt");
  assert.match(await t("Grep", { pattern: "^2$" }), /sub\/a\.txt:2:2/);
  assert.match(await t("Bash", { command: "echo hello" }), /exit code: 0\nhello/);
  assert.match(await t("Bash", { command: "sleep 5", timeout: 100 }), /exit code: timeout/);
  assert.match(await t("Read", { file_path: "missing" }), /^Error:/);
  assert.match(await runTool("Read", "{bad", ctx), /^Error: invalid JSON/);
});

test("getProvider config validation", () => {
  const dir = tmp();
  const good = join(dir, "good.json");
  writeFileSync(good, JSON.stringify({
    name: "openai-compatible", baseUrl: "http://localhost:11434/v1",
    apiKeyEnv: "OPENROUTER_API_KEY", models: { frontier: "a", workhorse: "b", cheap: "c" },
    pricesUsdPerMTok: { a: { input: 1, output: 2 } },
  }));
  const p = getProvider({ HIVEKIT_PROVIDER: "openai-compatible", HIVEKIT_PROVIDER_CONFIG: good });
  assert.equal(p.name, "openai-compatible");
  assert.equal(p.modelFor("plan"), "a");
  assert.equal(p.modelFor("build"), "b");

  const badJson = join(dir, "bad.json"); writeFileSync(badJson, "{nope");
  const badUrl = join(dir, "url.json");
  writeFileSync(badUrl, JSON.stringify({ name: "openai-compatible", baseUrl: 42, models: { frontier: "a", workhorse: "b" } }));
  const env = (c) => ({ HIVEKIT_PROVIDER: "openai-compatible", ...(c ? { HIVEKIT_PROVIDER_CONFIG: c } : {}) });
  assert.throws(() => getProvider(env()), /HIVEKIT_PROVIDER_CONFIG/);
  assert.throws(() => getProvider(env("/no/such.json")), /cannot read.*\/no\/such\.json/);
  assert.throws(() => getProvider(env(badJson)), /bad\.json is not valid JSON/);
  assert.throws(() => getProvider(env(badUrl)), /url\.json[\s\S]*baseUrl/);
  assert.throws(() => getProvider({ HIVEKIT_PROVIDER: "bogus" }), /unknown HIVEKIT_PROVIDER "bogus"/);
});
