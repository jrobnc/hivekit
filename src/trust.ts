import { spawn } from "child_process";
import { realpathSync } from "fs";
import { isAbsolute, relative, resolve, sep } from "path";
import type { CheckResult, Criterion, Mode } from "./types.js";

// The trust boundary: what agents may touch (policy half, below) and what the orchestrator
// runs itself (runner half). Pure on purpose — it imports nothing from sdk-utils, so tests
// that stub sdk-utils with a fixed export list can still load the real policy.

/** Tools of an agent that must not execute or write anything. */
export const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"] as const;

/** Tools for an agent in `mode`. Review mode is read-only (a prompt injection in unfamiliar code must not
 *  become code execution); HIVEKIT_REVIEW_ALLOW_BASH=1 adds Bash back. Env is read at CALL time. */
export function toolsFor(mode: Mode, tools: string[]): string[] {
  if (mode !== "review") return tools;
  return process.env.HIVEKIT_REVIEW_ALLOW_BASH === "1" ? [...READ_ONLY_TOOLS, "Bash"] : [...READ_ONLY_TOOLS];
}

/** The one start-up WARN line for the review Bash opt-in, or undefined. */
export function reviewBashWarning(mode: Mode, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (mode !== "review" || env.HIVEKIT_REVIEW_ALLOW_BASH !== "1") return undefined;
  return "[hivekit] WARN: HIVEKIT_REVIEW_ALLOW_BASH=1 — review agents get Bash and [auto] commands from the reviewed tree will run; a prompt injection in the reviewed repo can now execute commands on this machine.";
}

/** True when the intent file lives under cwd, lexically or after symlink resolution. Fails closed (true). */
export function intentInsideTree(intentPath: string, cwd: string): boolean {
  try {
    const under = (root: string, p: string) => {
      const rel = relative(root, p);
      // `..notes/HIVE.md` is inside the tree; only a `..` SEGMENT climbs out.
      return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
    };
    const roots = [resolve(cwd), realpathSync(cwd)];
    const cands = [resolve(intentPath), realpathSync(intentPath)];
    return cands.some((p) => roots.some((r) => under(r, p)));
  } catch {
    return true;
  }
}

/** Why review mode must not run the intent's [auto] commands, or undefined. An intent inside the reviewed
 *  tree is authored by the code under review. Env is read at CALL time, like toolsFor. */
export function reviewChecksBlocked(mode: Mode, intentPath: string | undefined, cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (mode === "review" && env.HIVEKIT_REVIEW_ALLOW_BASH !== "1" && intentPath && intentInsideTree(intentPath, cwd)) {
    return "intent is inside the reviewed tree";
  }
  return undefined;
}

const TAIL_BYTES = 8192;
const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1; // setTimeout overflows above this and fires immediately
const KILL_GRACE_MS = 5000; // SIGTERM → SIGKILL
const DRAIN_GRACE_MS = 2000; // after the shell exits, how long background children may hold the pipes

/** HIVEKIT_CHECK_TIMEOUT seconds → ms; absent or invalid → 600 s. */
export function checkTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.HIVEKIT_CHECK_TIMEOUT);
  return Number.isFinite(n) && n > 0 ? Math.min(n * 1000, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

/** Keep only the last TAIL_BYTES of a stream: bounded memory, never the full output. */
function tailBuffer() {
  let buf = Buffer.alloc(0);
  let total = 0;
  return {
    push(chunk: Buffer) {
      total += chunk.length;
      buf = Buffer.concat([buf, chunk]);
      buf = buf.subarray(Math.max(0, buf.length - TAIL_BYTES));
    },
    text: () => buf.toString("utf8"),
    bytes: () => total,
  };
}

function runOne(index: number, c: Criterion, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CheckResult> {
  const command = c.command!;
  const started = Date.now();
  const out = tailBuffer();
  const err = tailBuffer();
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let orphanedPipes = false;
    let spawnFailed = false;
    const timers: NodeJS.Timeout[] = [];
    const settle = (exitCode: number | null, stderrOverride?: string) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      resolve({
        index, text: c.text, command, exitCode, timedOut,
        durationMs: Date.now() - started,
        stdoutTail: out.text(),
        stderrTail: stderrOverride ?? err.text(),
        bytesStdout: out.bytes(),
        bytesStderr: err.bytes(),
        ...(orphanedPipes && { orphanedPipes: true as const }),
        ...(spawnFailed && { spawnFailed: true as const }),
      });
    };
    const destroyPipes = () => { child.stdout!.destroy(); child.stderr!.destroy(); };
    // shell:false — the shell is the explicit `bash -lc`; detached gives the command its own process group.
    const child = spawn("bash", ["-lc", command], { shell: false, cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    child.stdout!.on("data", (d: Buffer) => out.push(d));
    child.stderr!.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => { spawnFailed = true; settle(null, e.message); }); // e.g. bash missing: a failed record, never a throw
    child.on("close", (code) => settle(timedOut ? null : code));
    // The shell exited but a background child may still hold the pipes (`server &`): 'close' would never
    // fire. Give the pipes a moment to drain, then record the orphan and settle with the shell's own code.
    child.on("exit", (code) => {
      timers.push(setTimeout(() => {
        if (timedOut) return; // the SIGKILL timer owns a timed-out check: kill the group first, then settle via 'close'
        orphanedPipes = true;
        destroyPipes();
        settle(code);
      }, DRAIN_GRACE_MS));
    });
    timers.push(setTimeout(() => {
      timedOut = true;
      // Signal the whole group (grandchildren such as `sleep 5; echo x` hold the pipes), TERM first so
      // the command can clean up; KILL after a grace period.
      try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ }
      timers.push(setTimeout(() => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
        destroyPipes();
      }, KILL_GRACE_MS));
    }, Math.min(timeoutMs, MAX_TIMEOUT_MS)));
  });
}

/** Run every criterion that has a command, sequentially (npm test / npm run build can collide).
 *  One CheckResult per command, always. `index` is the criterion's 1-based position. */
export async function runChecks(
  criteria: Criterion[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<CheckResult[]> {
  const env = { ...(opts.env ?? process.env) };
  // The owner's command does not get the agent's credentials (ANTHROPIC_*, never restorable) nor
  // secret-looking vars, unless listed in HIVEKIT_CHECK_ENV_KEEP.
  const keep = (env.HIVEKIT_CHECK_ENV_KEEP ?? "").split(",").map((k) => k.trim());
  for (const k of Object.keys(env)) {
    if (/^ANTHROPIC_/.test(k) || k === "CLAUDE_CODE_OAUTH_TOKEN") delete env[k];
    else if (/(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)$/i.test(k) && !keep.includes(k)) delete env[k];
  }
  const timeoutMs = opts.timeoutMs ?? checkTimeoutMs();
  const results: CheckResult[] = [];
  for (let i = 0; i < criteria.length; i++) {
    if (criteria[i].command) results.push(await runOne(i + 1, criteria[i], opts.cwd, env, timeoutMs));
  }
  return results;
}
