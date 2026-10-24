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
  assert.deepEqual(Object.keys(r).sort(), ["bytesStderr", "bytesStdout", "command", "durationMs", "exitCode", "index", "stderrTail", "stdoutTail", "text", "timedOut"]);
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
  assert.equal(r.spawnFailed, true);
});

test("checkTimeoutMs", () => {
  assert.equal(checkTimeoutMs({}), 600000);
  assert.equal(checkTimeoutMs({ HIVEKIT_CHECK_TIMEOUT: "2" }), 2000);
  assert.equal(checkTimeoutMs({ HIVEKIT_CHECK_TIMEOUT: "abc" }), 600000);
  assert.equal(checkTimeoutMs({ HIVEKIT_CHECK_TIMEOUT: "-1" }), 600000);
});

test("checkTimeoutMs clamps; a huge opts.timeoutMs does not fire immediately", async () => {
  assert.equal(checkTimeoutMs({ HIVEKIT_CHECK_TIMEOUT: "1e12" }), 2 ** 31 - 1);
  const r = await run("true", { timeoutMs: 1e15 });
  assert.equal(r.timedOut, false);
  assert.equal(r.exitCode, 0);
});

test("timeout: SIGTERM is honoured; a TERM-ignoring command is killed after the grace", async () => {
  const a = await run("sleep 30", { timeoutMs: 500 });
  assert.equal(a.timedOut, true);
  assert.equal(a.exitCode, null);
  assert.ok(a.durationMs < 3000, `TERM honoured (${a.durationMs}ms)`);
  const b = await run("trap '' TERM; sleep 30", { timeoutMs: 500 });
  assert.equal(b.timedOut, true);
  assert.ok(b.durationMs >= 5000, `killed after grace (${b.durationMs}ms)`);
});

test("timeout: shell dies on TERM but a TERM-ignoring child is still KILLed, not settled as an orphan", async () => {
  const r = await run(`sh -c 'trap "" TERM; exec sleep 30' & wait`, { timeoutMs: 500 });
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null);
  assert.ok(r.durationMs >= 5000, `KILL timer settled it (${r.durationMs}ms)`);
  assert.ok(!("orphanedPipes" in r), "a timeout is not mislabelled as an orphan");
});

test("a background child holding the pipes is recorded, not waited for", async () => {
  const r = await run("sleep 4 & exit 0");
  assert.equal(r.exitCode, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.orphanedPipes, true);
  assert.ok(r.durationMs < 3500, `${r.durationMs}ms`);
  assert.ok(!("orphanedPipes" in (await run("true"))));
});

test("byte counts are totals, not tail sizes", async () => {
  const r = await run("head -c 20000 /dev/zero | tr '\\0' x; printf abc >&2");
  assert.equal(r.bytesStdout, 20000);
  assert.equal(r.bytesStderr, 3);
});

test("secret-looking and agent env vars are stripped; HIVEKIT_CHECK_ENV_KEEP restores non-agent ones", async () => {
  const base = { ...process.env, GITHUB_TOKEN: "g", CLAUDE_CODE_OAUTH_TOKEN: "o", ANTHROPIC_BASE_URL: "b", MY_SECRET: "s" };
  const cmd = 'echo "$GITHUB_TOKEN|$CLAUDE_CODE_OAUTH_TOKEN|$ANTHROPIC_BASE_URL|$MY_SECRET"';
  assert.equal((await run(cmd, { env: base })).stdoutTail.trim(), "|||");
  const kept = await run(cmd, { env: { ...base, HIVEKIT_CHECK_ENV_KEEP: "GITHUB_TOKEN, CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_BASE_URL" } });
  assert.equal(kept.stdoutTail.trim(), "g|||");
});
