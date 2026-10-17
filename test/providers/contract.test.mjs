import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeOpenAI, reply } from "../helpers/fake-openai.mjs";

mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: async function* () {
      yield { type: "assistant" };
      yield {
        type: "result", subtype: "success", is_error: false, result: "fine", session_id: "s1",
        total_cost_usd: 0.01, num_turns: 2,
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
      };
    },
  },
});
const { claudeProvider } = await import("../../dist/providers/claude.js");
const { createOpenAICompatibleProvider } = await import("../../dist/providers/openai-compatible.js");

const ROLES = ["plan", "build", "review", "evaluate", "advise"];

test("both providers satisfy the same Provider contract", async () => {
  const srv = await startFakeOpenAI(() => reply({ role: "assistant", content: "fine" }));
  try {
    const oai = createOpenAICompatibleProvider({
      name: "openai-compatible", baseUrl: srv.url, models: { frontier: "big", workhorse: "small" },
    });
    for (const p of [claudeProvider, oai]) {
      for (const r of ROLES) assert.ok(p.modelFor(r).length > 0, `${p.name} modelFor(${r})`);
      const out = await p.run({
        prompt: "go", model: p.modelFor("build"), allowedTools: ["Read"], permissionMode: "acceptEdits", maxTurns: 3,
      });
      assert.ok(out.result.length > 0, p.name);
      assert.ok(out.turns >= 1, p.name);
      for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
        assert.equal(typeof out.usage[k], "number", `${p.name} ${k}`);
      }
      assert.ok(out.model.length > 0);
      assert.equal(out.isError, false);
      assert.equal(typeof out.sessionId, "string");
    }
  } finally { await srv.close(); }
});

test("claude preflight", async () => {
  const saved = { ...process.env };
  const emptyBin = mkdtempSync(join(tmpdir(), "hk-bin-"));
  const home = mkdtempSync(join(tmpdir(), "hk-home-"));
  const clean = () => {
    delete process.env.HIVEKIT_ALLOW_NO_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.HOME = home;
    process.env.PATH = emptyBin; // `security` cannot be found
  };
  try {
    clean();
    await assert.rejects(claudeProvider.preflight(), /no Claude Max OAuth token/);
    process.env.HIVEKIT_ALLOW_NO_TOKEN = "1";
    await claudeProvider.preflight();
    clean();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "t";
    await claudeProvider.preflight();
    clean();
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
    await claudeProvider.preflight();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
