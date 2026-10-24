// The real read-only enforcement: allowedTools only auto-approves in the Claude SDK; `tools` removes tools.
// A test asserting allowedTools alone would pass even if claude.ts never sent `tools`.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const seen = [];
mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: async function* ({ options }) {
      seen.push(options);
      yield { type: "result", subtype: "success", is_error: false, result: "", session_id: "s", total_cost_usd: 0, num_turns: 1, usage: {} };
    },
  },
});
const { claudeProvider } = await import("../../dist/providers/claude.js");

const run = (allowedTools, mode) =>
  claudeProvider.run({ prompt: "p", model: "m", cwd: ".", allowedTools, permissionMode: "acceptEdits", maxTurns: 1, mode });

test("claude adapter: a list without Write becomes the hard tool set", async () => {
  await run(["Read", "Glob", "Grep"]);
  assert.deepEqual(seen.at(-1).tools, ["Read", "Glob", "Grep"]);
});

test("claude adapter: writers keep the SDK default tool set", async () => {
  await run(["Read", "Write", "Edit", "Bash"]);
  assert.equal(seen.at(-1).tools, undefined);
});

test("claude adapter: review mode loads user settings only; other modes leave settingSources absent", async () => {
  await run(["Read"], "review");
  assert.deepEqual(seen.at(-1).settingSources, ["user"]);
  for (const mode of ["build", "improve", undefined]) {
    await run(["Read"], mode);
    assert.equal("settingSources" in seen.at(-1), false, `mode ${mode}`);
  }
});
