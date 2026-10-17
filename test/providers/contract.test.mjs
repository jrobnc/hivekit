import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeOpenAI, reply, toolCall } from "../helpers/fake-openai.mjs";

// The claude side proves plumbing (cwd/allowedTools/usage forwarding), not the real CLI.
const seen = [];
mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: async function* ({ prompt, options }) {
      seen.push(options);
      const content = readFileSync(join(options.cwd, "golden.txt"), "utf-8");
      yield { type: "assistant" };
      yield {
        type: "result", subtype: "success", is_error: false, result: "answer: " + content, session_id: "s1",
        total_cost_usd: 0.01, num_turns: 2,
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
      };
    },
  },
});
const { claudeProvider } = await import("../../dist/providers/claude.js");
const { createOpenAICompatibleProvider } = await import("../../dist/providers/openai-compatible.js");

const ROLES = ["plan", "build", "review", "evaluate", "advise"];

test("both providers complete the same golden Read task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hivekit-contract-"));
  const token = randomUUID();
  writeFileSync(join(dir, "golden.txt"), token);
  const srv = await startFakeOpenAI((body, i) => {
    if (i === 0) return reply(toolCall("Read", { file_path: "golden.txt" }));
    const toolMsg = body.messages.find((m) => m.role === "tool");
    return reply({ role: "assistant", content: `answer: ${toolMsg.content}` });
  });
  try {
    const oai = createOpenAICompatibleProvider({
      name: "openai-compatible", baseUrl: srv.url, models: { frontier: "big", workhorse: "small" },
    });
    for (const p of [claudeProvider, oai]) {
      for (const r of ROLES) assert.ok(p.modelFor(r).length > 0, `${p.name} modelFor(${r})`);
      const out = await p.run({
        prompt: "Read golden.txt and repeat it", model: p.modelFor("build"), cwd: dir,
        allowedTools: ["Read"], permissionMode: "acceptEdits", maxTurns: 3,
      });
      assert.ok(out.result.includes(token), `${p.name} result`);
      assert.equal(out.isError, false, p.name);
    }
    assert.deepEqual(srv.requests[0].body.tools.map((t) => t.function.name), ["Read"]);
    assert.equal(srv.requests.length, 2);
    assert.ok(seen[0].allowedTools.includes("Read"));
    assert.equal(seen[0].cwd, dir);
    const out = await claudeProvider.run({
      prompt: "x", model: "m", cwd: dir, allowedTools: ["Read"], permissionMode: "acceptEdits", maxTurns: 3,
    });
    assert.deepEqual(out.usage, { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 });
  } finally { await srv.close(); }
});
