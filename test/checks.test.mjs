// runChecks: the orchestrator runs [auto] commands itself. No network, no agents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runChecks, checkTimeoutMs } from "../dist/trust.js";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "hivekit-checks-")));
const run = (command, opts = {}) =>
  runChecks([{ tier: "auto", text: "t", command }], { cwd: dir, ...opts }).then((r) => r[0]);

test("exit code is recorded, not timed out", async () => {
  const r = await run("exit 3");
  assert.equal(r.exitCode, 3);
  assert.equal(r.timedOut, false);
});

test("timeout kills the whole process group (grandchild holds the pipe)", async () => {
  const t0 = Date.now();
  const r = await run("sleep 5; echo late", { timeoutMs: 1000 });
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null);
  assert.ok(Date.now() - t0 < 4000, "returned before the grandchild finished");
  assert.ok(!r.stdoutTail.includes("late"));
});

test("stdout and stderr are bounded rolling tails", async () => {
  const r = await run("head -c 20000 /dev/zero | tr '\\0' x; printf END; head -c 20000 /dev/zero | tr '\\0' y >&2; printf END >&2");
  for (const t of [r.stdoutTail, r.stderrTail]) {
    assert.ok(Buffer.byteLength(t) <= 8192);
    assert.ok(t.endsWith("END"));
  }
});

test("result shape is exact; index is the 1-based criterion position", async () => {
  const [r] = await runChecks(
    [{ tier: "human", text: "h" }, { tier: "auto", text: "t", command: "true" }],
    { cwd: dir }
  );
  assert.deepEqual(Object.keys(r).sort(), ["command", "durationMs", "exitCode", "index", "stderrTail", "stdoutTail", "text", "timedOut"]);
  assert.equal(r.index, 2);
});

test("ANTHROPIC_API_KEY is stripped; cwd is honoured", async () => {
  const env = { ...process.env, ANTHROPIC_API_KEY: "sk-test" };
  assert.match((await run('echo "${ANTHROPIC_API_KEY:-unset}"', { env })).stdoutTail, /unset/);
  assert.equal((await run("pwd")).stdoutTail.trim().split("\n").pop(), dir);
});

test("spawn failure becomes a failed record, never a throw", async () => {
  const [r] = await runChecks([{ tier: "auto", text: "t", command: "true" }], { cwd: join(dir, "does-not-exist") });
  assert.equal(r.exitCode, null);
  assert.ok(r.stderrTail.length > 0);
});

test("checkTimeoutMs", () => {
  assert.equal(checkTimeoutMs({}), 600000);
  assert.equal(checkTimeoutMs({ HIVEKIT_CHECK_TIMEOUT: "2" }), 2000);
  assert.equal(checkTimeoutMs({ HIVEKIT_CHECK_TIMEOUT: "abc" }), 600000);
  assert.equal(checkTimeoutMs({ HIVEKIT_CHECK_TIMEOUT: "-1" }), 600000);
});
