import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  liveRuns, otherLiveRuns, looksLikeHivekit, registerRun, trackAgent, unregisterRun, readPressureLevel, checkAdmission, agentBudget, ADMISSION_EXIT_CODE,
} from "../dist/registry.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = () => mkdtempSync(join(tmpdir(), "hivekit-registry-"));
const entry = (o = {}) => ({ pid: process.pid, runId: "x", cwd: "/some/app", mode: "build", startedAt: "2026-10-18T20:41:44.000Z", agents: 0, ...o });
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

test("register/trackAgent/unregister writes and removes the registry file", () => {
  const dir = tmp();
  const prev = process.env.HIVEKIT_RUNS_DIR;
  process.env.HIVEKIT_RUNS_DIR = dir;
  try {
    registerRun({ runId: "r1", cwd: "/c", mode: "review" });
    const file = join(dir, "r1.json");
    const read = () => JSON.parse(readFileSync(file, "utf-8"));
    assert.deepEqual(Object.keys(read()).sort(), ["agents", "cwd", "mode", "pid", "runId", "startedAt"]);
    assert.equal(read().pid, process.pid);
    assert.equal(read().agents, 0);
    trackAgent(1);
    assert.equal(read().agents, 1);
    trackAgent(-1);
    assert.equal(read().agents, 0);
    unregisterRun();
    assert.equal(existsSync(file), false);
    assert.doesNotThrow(() => unregisterRun());
  } finally {
    if (prev === undefined) delete process.env.HIVEKIT_RUNS_DIR; else process.env.HIVEKIT_RUNS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("liveRuns prunes dead pids, keeps live ones, skips unparseable files", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "dead.json"), JSON.stringify(entry({ pid: deadPid() })));
    writeFileSync(join(dir, "live.json"), JSON.stringify(entry()));
    writeFileSync(join(dir, "bad.json"), "{nope");
    const runs = liveRuns(dir);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].pid, process.pid);
    assert.equal(existsSync(join(dir, "dead.json")), false);
    assert.equal(existsSync(join(dir, "bad.json")), true);
    assert.deepEqual(liveRuns(join(dir, "missing")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGTERM removes the registry file and exits 143", async () => {
  const dir = tmp();
  try {
    const code = `import("${join(root, "dist", "registry.js")}").then(m => { m.registerRun({ runId: "sig", cwd: "/c", mode: "build" }); console.log("ready"); setInterval(() => {}, 1000); })`;
    const child = spawn(process.execPath, ["-e", code], { env: { ...process.env, HIVEKIT_RUNS_DIR: dir }, stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((res) => child.stdout.on("data", (d) => String(d).includes("ready") && res()));
    assert.equal(existsSync(join(dir, "sig.json")), true);
    const exited = new Promise((res) => child.on("exit", (c, s) => res({ c, s })));
    child.kill("SIGTERM");
    const { c } = await exited;
    assert.equal(c, 143);
    assert.equal(existsSync(join(dir, "sig.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkAdmission: max runs", () => {
  const r = checkAdmission([entry()], 1, {});
  assert.equal(r.ok, false);
  assert.match(r.message, new RegExp(String(process.pid)));
  assert.match(r.message, /\/some\/app/);
  assert.match(r.message, /build/);
  assert.equal(checkAdmission([entry()], 1, { HIVEKIT_MAX_RUNS: "2" }).ok, true);
});

test("checkAdmission: memory pressure", () => {
  assert.match(checkAdmission([], 2, {}).message, /warning \(level 2\)/);
  assert.match(checkAdmission([], 4, {}).message, /critical/);
  assert.equal(checkAdmission([], 1, {}).ok, true);
  assert.equal(checkAdmission([], undefined, {}).ok, true);
});

test("checkAdmission: HIVE_ADMIT=1 bypasses both checks", () => {
  assert.deepEqual(checkAdmission([entry()], 4, { HIVE_ADMIT: "1" }), { ok: true, bypassed: true });
});

test("agentBudget", () => {
  assert.deepEqual(agentBudget(1, {}), { budget: 3 });
  assert.equal(agentBudget(1, { HIVEKIT_MAX_AGENTS: "5" }).budget, 5);
  const p = agentBudget(2, { HIVEKIT_MAX_AGENTS: "5" });
  assert.equal(p.budget, 1);
  assert.match(p.reason, /pressure/);
  assert.equal(agentBudget(1, { HIVEKIT_MAX_AGENTS: "0" }).budget, 3);
  assert.match(agentBudget(1, { HIVEKIT_MAX_AGENTS: "2" }).reason, /HIVEKIT_MAX_AGENTS=2/);
});

test("readPressureLevel skips non-darwin and tolerates sysctl failure", () => {
  assert.equal(readPressureLevel("linux", () => { throw new Error("must not be called"); }), undefined);
  assert.equal(readPressureLevel("darwin", () => { throw new Error("boom"); }), undefined);
  assert.equal(readPressureLevel("darwin", () => "2\n"), 2);
  assert.equal(readPressureLevel("darwin", () => "abc"), undefined);
});

test("ADMISSION_EXIT_CODE is 75", () => assert.equal(ADMISSION_EXIT_CODE, 75));

// ── CLI paths (spawn dist/index.js; never a run that passes admission) ──
const cli = (args, dir, extra = {}) =>
  spawnSync(process.execPath, [join(root, "dist", "index.js"), ...args], {
    encoding: "utf-8",
    env: { ...process.env, HIVEKIT_RUNS_DIR: dir, HIVEKIT_ALLOW_NO_TOKEN: "1", HIVE_ADMIT: "0", ...extra },
  });

test("CLI refuses with exit 75 when a run is active, creating no run dir", () => {
  const dir = tmp();
  const cwd = tmp();
  try {
    writeFileSync(join(dir, "x.json"), JSON.stringify(entry({ cwd: "/seeded/cwd" })));
    const r = cli(["review something", "--cwd", cwd], dir);
    assert.equal(r.status, 75);
    assert.ok(r.stderr.includes(String(process.pid)));
    assert.ok(r.stderr.includes("/seeded/cwd"));
    assert.equal(existsSync(join(cwd, ".hivekit")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const arg of ["status", "--status"]) {
  test(`CLI ${arg} prints one JSON line, prunes dead entries`, () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "live.json"), JSON.stringify(entry()));
      writeFileSync(join(dir, "dead.json"), JSON.stringify(entry({ pid: deadPid() })));
      const r = cli([arg], dir);
      assert.equal(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.equal(out.runs.length, 1);
      assert.ok("pressure_level" in out);
      assert.ok(out.pressure_level === null || typeof out.pressure_level === "number");
      assert.equal(existsSync(join(dir, "dead.json")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("CLI status on an empty or missing dir reports no runs", () => {
  const dir = tmp();
  try {
    assert.deepEqual(JSON.parse(cli(["status"], dir).stdout).runs, []);
    const r = cli(["status"], join(dir, "missing"));
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout).runs, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--help documents status, env vars, and exit 75", () => {
  const out = cli(["--help"], tmp()).stdout;
  for (const s of ["status", "HIVEKIT_MAX_RUNS", "HIVEKIT_MAX_AGENTS", "HIVEKIT_RUNS_DIR", "HIVE_ADMIT", "75"]) {
    assert.ok(out.includes(s), `help missing ${s}`);
  }
});

test("liveRuns prunes a live pid that is no longer a hivekit (pid reuse after SIGKILL)", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "reused.json"), JSON.stringify(entry({ runId: "reused" })));
    writeFileSync(join(dir, "real.json"), JSON.stringify(entry({ runId: "real" })));
    const seen = [];
    const live = liveRuns(dir, (pid) => { seen.push(pid); return false; });
    assert.equal(live.length, 0);
    assert.equal(existsSync(join(dir, "reused.json")), false, "file of the reused pid is removed");
    assert.equal(seen.length, 2);
    writeFileSync(join(dir, "real.json"), JSON.stringify(entry({ runId: "real" })));
    assert.equal(liveRuns(dir, () => true).length, 1);
    // the default verifier recognises this node test process
    assert.equal(looksLikeHivekit(process.pid), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("otherLiveRuns excludes this process; unregisterRun forgets the current run", () => {
  const dir = tmp();
  const prev = process.env.HIVEKIT_RUNS_DIR;
  process.env.HIVEKIT_RUNS_DIR = dir;
  try {
    registerRun({ runId: "me", cwd: "/c", mode: "review" });
    writeFileSync(join(dir, "other.json"), JSON.stringify(entry({ runId: "other", pid: process.ppid })));
    assert.deepEqual(otherLiveRuns(dir).map((r) => r.runId), ["other"]);
    unregisterRun();
    trackAgent(1);
    assert.equal(existsSync(join(dir, "me.json")), false, "trackAgent after unregister recreates nothing");
  } finally {
    if (prev === undefined) delete process.env.HIVEKIT_RUNS_DIR; else process.env.HIVEKIT_RUNS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
