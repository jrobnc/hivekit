// Stand-in for @anthropic-ai/claude-agent-sdk, injected ONLY by the test loader
// hook in test/helpers/register-stub.mjs. Production code has no knowledge of
// this file and no switch that could select it — see the note in
// test/verification-boundary.test.mjs.
//
// Behaviour is driven by a JSON script whose path is in HIVEKIT_TEST_SDK_SCRIPT:
//   { "calls": [ { when?, writePathPattern?, content?, result, isError? }, ... ] }
// Entries with a `when` regex are selected by matching it against the prompt —
// use this when call ORDER is not fixed (review mode fans out a variable number
// of dimension agents, so index counting silently feeds the evaluator a
// generator's entry). Entries without `when` are consumed in order.
// If `writePathPattern` is set, the first absolute path in the prompt matching
// it is written with `content` — this is how the fake stands in for an agent
// that writes plan/progress/findings/report files.
import { readFileSync, writeFileSync } from "node:fs";

let callIndex = 0;

function loadScript() {
  const path = process.env.HIVEKIT_TEST_SDK_SCRIPT;
  if (!path) throw new Error("fake-sdk: HIVEKIT_TEST_SDK_SCRIPT is not set");
  return JSON.parse(readFileSync(path, "utf-8"));
}

export async function* query({ prompt }) {
  const script = loadScript();
  const byPrompt = script.calls.find(
    (c) => c.when && new RegExp(c.when).test(String(prompt))
  );
  const entry = byPrompt ?? script.calls[callIndex] ?? script.calls[script.calls.length - 1];
  callIndex++;

  // Simulates an SDK/transport that drops its callback: never settles, holds no
  // libuv handle, so Node's event loop simply drains and the process exits
  // without main() ever resolving or rejecting.
  if (entry.hang) await new Promise(() => {});

  if (entry.writePathPattern) {
    const re = new RegExp(`[^\\s\`'"()]*${entry.writePathPattern}`, "g");
    const found = [...String(prompt).matchAll(re)].map((m) => m[0]);
    const target = found.find((p) => p.startsWith("/"));
    if (target) writeFileSync(target, entry.content ?? "", "utf-8");
  }

  yield { type: "assistant", message: { content: [] } };
  yield {
    type: "result",
    result: entry.result ?? "",
    session_id: `fake-session-${callIndex}`,
    duration_ms: 1,
    total_cost_usd: 0,
    is_error: entry.isError === true,
  };
}
