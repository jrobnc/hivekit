import { spawn } from "child_process";
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
  return "[hivekit] WARN: HIVEKIT_REVIEW_ALLOW_BASH=1 — review agents get Bash; a prompt injection in the reviewed repo can now execute commands on this machine.";
}

const TAIL_BYTES = 8192;
const DEFAULT_TIMEOUT_MS = 600_000;

/** HIVEKIT_CHECK_TIMEOUT seconds → ms; absent or invalid → 600 s. */
export function checkTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.HIVEKIT_CHECK_TIMEOUT);
  return Number.isFinite(n) && n > 0 ? n * 1000 : DEFAULT_TIMEOUT_MS;
}

/** Keep only the last TAIL_BYTES of a stream: bounded memory, never the full output. */
function tailBuffer() {
  let buf = Buffer.alloc(0);
  return {
    push(chunk: Buffer) {
      buf = Buffer.concat([buf, chunk]);
      buf = buf.subarray(Math.max(0, buf.length - TAIL_BYTES));
    },
    text: () => buf.toString("utf8"),
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
    let timer: NodeJS.Timeout | undefined;
    const settle = (exitCode: number | null, stderrOverride?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        index, text: c.text, command, exitCode, timedOut,
        durationMs: Date.now() - started,
        stdoutTail: out.text(),
        stderrTail: stderrOverride ?? err.text(),
      });
    };
    // shell:false — the shell is the explicit `bash -lc`; detached gives the command its own process group.
    const child = spawn("bash", ["-lc", command], { shell: false, cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    child.stdout!.on("data", (d: Buffer) => out.push(d));
    child.stderr!.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => settle(null, e.message)); // e.g. bash missing: a failed record, never a throw
    child.on("close", (code) => settle(timedOut ? null : code));
    timer = setTimeout(() => {
      timedOut = true;
      // Killing only bash leaves grandchildren (`sleep 5; echo x`) holding the pipes open and
      // 'close' never fires: kill the whole group, then drop the pipes.
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
      child.stdout!.destroy();
      child.stderr!.destroy();
    }, timeoutMs);
  });
}

/** Run every criterion that has a command, sequentially (npm test / npm run build can collide).
 *  One CheckResult per command, always. `index` is the criterion's 1-based position. */
export async function runChecks(
  criteria: Criterion[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<CheckResult[]> {
  const env = { ...(opts.env ?? process.env) };
  delete env.ANTHROPIC_API_KEY; // the owner's command does not get the agent's credential
  const timeoutMs = opts.timeoutMs ?? checkTimeoutMs();
  const results: CheckResult[] = [];
  for (let i = 0; i < criteria.length; i++) {
    if (criteria[i].command) results.push(await runOne(i + 1, criteria[i], opts.cwd, env, timeoutMs));
  }
  return results;
}
