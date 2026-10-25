// Machine-wide run registry + memory-aware admission. Sync fs on purpose: the "exit" listener must be synchronous.
// Must not import sdk-utils.ts (sdk-utils calls trackAgent) — that would be an import cycle.
import { execFileSync } from "child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { positiveInt } from "./turns.js";
import type { Mode } from "./types.js";

export interface RunEntry { pid: number; runId: string; cwd: string; mode: Mode; startedAt: string; agents: number }

// EX_TEMPFAIL (sysexits.h): "try again later".
export const ADMISSION_EXIT_CODE = 75;

const DEFAULT_MAX_RUNS = 1;
const DEFAULT_MAX_AGENTS = 3;

export function runsDir(env: Record<string, string | undefined> = process.env): string {
  return env.HIVEKIT_RUNS_DIR || join(homedir(), ".hivekit", "runs");
}

/**
 * Is this live pid plausibly a hivekit run? A run killed by SIGKILL (memguard, OOM, a reboot
 * that reused the pid space) leaves its file behind; if the pid now belongs to something else,
 * counting it would refuse every run forever. `ps` is read-only; when it fails we keep the entry.
 */
export function looksLikeHivekit(pid: number): boolean {
  try {
    const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    return /(^|\/)node(\s|$)|hivekit|dist\/index\.js/.test(cmd);
  } catch {
    return true;
  }
}

export function liveRuns(dir = runsDir(), isHivekit: (pid: number) => boolean = looksLikeHivekit): RunEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("."));
  } catch {
    return [];
  }
  const live: RunEntry[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let entry: RunEntry;
    try {
      entry = JSON.parse(readFileSync(path, "utf-8"));
      if (!Number.isInteger(entry.pid)) continue;
    } catch {
      continue; // unparseable: skip, don't delete
    }
    try {
      process.kill(entry.pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        try { unlinkSync(path); } catch { /* raced with another pruner */ }
        continue;
      }
      // EPERM: alive, owned by another user — keep
    }
    if (!isHivekit(entry.pid)) {
      try { unlinkSync(path); } catch { /* raced */ }
      continue; // pid reused by an unrelated process: the run is gone
    }
    live.push(entry);
  }
  return live;
}

/** Live runs other than this process: what admission counts once we are registered. */
export function otherLiveRuns(dir = runsDir()): RunEntry[] {
  return liveRuns(dir).filter((r) => r.pid !== process.pid);
}

let current: { path: string; entry: RunEntry } | undefined;

// Bookkeeping only (like the ledger): a registry failure must never crash a run.
function write(): void {
  if (!current) return;
  try {
    const tmp = join(runsDir(), `.${current.entry.runId}.json.tmp`);
    writeFileSync(tmp, JSON.stringify(current.entry, null, 2) + "\n");
    renameSync(tmp, current.path); // atomic so readers never see half-written JSON
  } catch (err) {
    console.warn(`[hivekit] could not update run registry: ${(err as Error).message}`);
  }
}

export function unregisterRun(): void {
  if (!current) return;
  try { rmSync(current.path, { force: true }); } catch { /* never throw */ }
  current = undefined; // a later trackAgent must not recreate the file
}

export function registerRun(e: { runId: string; cwd: string; mode: Mode }): void {
  try {
    mkdirSync(runsDir(), { recursive: true });
  } catch (err) {
    console.warn(`[hivekit] could not create run registry dir: ${(err as Error).message}`);
    return;
  }
  current = {
    path: join(runsDir(), `${e.runId}.json`),
    entry: { pid: process.pid, runId: e.runId, cwd: e.cwd, mode: e.mode, startedAt: new Date().toISOString(), agents: 0 },
  };
  write();
  process.on("exit", unregisterRun);
  // A listener replaces Node's default kill, so exit explicitly (128+signo).
  process.once("SIGINT", () => { unregisterRun(); process.exit(130); });
  process.once("SIGTERM", () => { unregisterRun(); process.exit(143); });
}

export function trackAgent(delta: 1 | -1): void {
  if (!current) return;
  current.entry.agents = Math.max(0, current.entry.agents + delta);
  write();
}

export function readPressureLevel(
  platform: string = process.platform,
  sysctl: () => string = () =>
    execFileSync("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    })
): number | undefined {
  if (platform !== "darwin") return undefined;
  try {
    const n = Number.parseInt(sysctl().trim(), 10);
    return Number.isInteger(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

export function pressureName(level: number): string {
  return level === 1 ? "normal" : level === 2 ? "warning" : level === 4 ? "critical" : `level ${level}`;
}

const pressureLabel = (n: number) => (pressureName(n).startsWith("level") ? pressureName(n) : `${pressureName(n)} (level ${n})`);

export function checkAdmission(
  runs: RunEntry[],
  pressure: number | undefined,
  env: Record<string, string | undefined> = process.env
): { ok: true; bypassed: boolean } | { ok: false; message: string } {
  if (env.HIVE_ADMIT === "1") return { ok: true, bypassed: true };
  const max = positiveInt(env.HIVEKIT_MAX_RUNS) ?? DEFAULT_MAX_RUNS;
  if (runs.length >= max) {
    const lines = runs.map((r) => `  pid ${r.pid} · ${r.cwd} · ${r.mode} · started ${r.startedAt}`);
    return {
      ok: false,
      message:
        `[hivekit] REFUSED: ${runs.length} hivekit run(s) already active (HIVEKIT_MAX_RUNS=${max}):\n${lines.join("\n")}\n` +
        `Wait for it to finish, raise HIVEKIT_MAX_RUNS, or set HIVE_ADMIT=1 to bypass.`,
    };
  }
  // Refuse only at critical (level 4). "warning" is the compressor filling, which is normal on a Mac with
  // many sessions open; at warning a run is still admitted but agentBudget() drops it to one agent per phase.
  // The hive-stats memguard daemon handles genuine exhaustion by pausing the biggest session.
  if (pressure !== undefined && pressure >= 4) {
    return {
      ok: false,
      message: `[hivekit] REFUSED: macOS memory pressure is ${pressureLabel(pressure)}. Close sessions and retry, or set HIVE_ADMIT=1 to bypass.`,
    };
  }
  return { ok: true, bypassed: false };
}

export function agentBudget(
  pressure: number | undefined = readPressureLevel(),
  env: Record<string, string | undefined> = process.env
): { budget: number; reason?: string } {
  const configured = positiveInt(env.HIVEKIT_MAX_AGENTS);
  const budget = configured ?? DEFAULT_MAX_AGENTS;
  if (pressure !== undefined && pressure >= 2) {
    return { budget: 1, reason: `memory pressure ${pressureLabel(pressure)}` };
  }
  return configured !== undefined && configured < DEFAULT_MAX_AGENTS
    ? { budget, reason: `HIVEKIT_MAX_AGENTS=${configured}` }
    : { budget };
}
