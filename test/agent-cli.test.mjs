// CLI tests for `hivekit --agent` (validate, usage errors, no side effects, attribution).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "index.js");
const REGISTER = join(ROOT, "test", "helpers", "register-stub.mjs");

const BODY = "## Objective\nDo it.\n\n## Success Criteria\n- [auto] passes: `true`\n- [judge] reads well\n";
const VALID = `---\nname: test-agent\ndescription: "ZZ-FRONTMATTER-TOKEN"\nschedule: weekdays 07:30\n---\n${BODY}`;
const INVALID = `---\nshedule: x\n---\n## Objective\n`;

function ws() {
  const dir = mkdtempSync(join(tmpdir(), "hivekit-agent-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const file = (name, text) => { const p = join(dir, name); writeFileSync(p, text, "utf-8"); return p; };
  return { dir, repo, file, ledger: join(dir, "ledger.jsonl"), marker: join(dir, "marker") };
}

/** Run the CLI with the fake SDK; `calls` is the fake-SDK script. */
function cli(w, args, calls = [{ result: "x" }]) {
  const script = w.file("sdk-script.json", JSON.stringify({ calls }));
  const r = spawnSync("node", ["--import", REGISTER, CLI, ...args, "--cwd", w.repo], {
    encoding: "utf-8",
    timeout: 60000,
    env: { ...process.env, NODE_OPTIONS: "", HIVE_ADMIT: "1", HIVEKIT_ADVISOR: "0", HIVEKIT_TEST_SDK_SCRIPT: script, HIVEKIT_LEDGER: w.ledger },
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const ledgerLines = (w) => (existsSync(w.ledger) ? readFileSync(w.ledger, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("--validate: valid file prints the ok line, exits 0", () => {
  const w = ws();
  const r = cli(w, ["--agent", w.file("a.md", VALID), "--validate"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "agent test-agent: ok (2 criteria; schedule weekdays 07:30)");
});

test("--validate --json: one object, seven agent keys, boolean hasCommand", () => {
  const w = ws();
  const r = cli(w, ["--agent", w.file("a.md", VALID), "--validate", "--json"]);
  assert.equal(r.code, 0);
  const o = JSON.parse(r.stdout);
  assert.equal(o.ok, true);
  assert.deepEqual(Object.keys(o.agent), ["name", "description", "schedule", "project", "principal", "output", "budgetUsd"]);
  assert.equal(o.agent.project, null);
  assert.deepEqual(o.criteria.map((c) => c.hasCommand), [true, false]);
  assert.ok(!o.body.startsWith("---"));
});

test("--validate on an invalid file: prefixed stderr, exit 2; --json gives unprefixed errors on stdout", () => {
  const w = ws();
  const f = w.file("bad.md", INVALID);
  const t = cli(w, ["--agent", f, "--validate"]);
  assert.equal(t.code, 2);
  assert.match(t.stderr, /^agent: line 2: unknown key "shedule"$/m);
  const j = cli(w, ["--agent", f, "--validate", "--json"]);
  assert.equal(j.code, 2);
  const o = JSON.parse(j.stdout);
  assert.equal(o.ok, false);
  assert.ok(o.errors.includes('line 2: unknown key "shedule"'));
});

test("--validate writes nothing", () => {
  const w = ws();
  cli(w, ["--agent", w.file("a.md", VALID), "--validate"]);
  assert.equal(existsSync(join(w.repo, ".hivekit")), false);
  assert.equal(existsSync(w.ledger), false);
});

test("invalid agent run: exit 2 before any run dir, ledger line, provider call or banner", () => {
  const w = ws();
  const r = cli(w, ["--agent", w.file("bad.md", INVALID)], [{ writeFiles: [{ path: w.marker, content: "x" }], result: "x" }]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^agent: /m);
  assert.equal(existsSync(join(w.repo, ".hivekit")), false);
  assert.equal(ledgerLines(w).length, 0);
  assert.equal(existsSync(w.marker), false);
  assert.doesNotMatch(r.stdout, /┌|Run ID|\[intent\]/);
});

test("usage conflicts exit 2", () => {
  const w = ws();
  const f = w.file("a.md", VALID);
  for (const args of [
    ["--agent", f, "--intent", f], ["--agent", f, "--plan", f], ["--agent", f, "--check", "true"],
    ["--agent", f, "a task"], ["--validate"], ["--json"],
  ]) assert.equal(cli(w, args).code, 2, args.join(" "));
});

const PASS = `EVALUATION: PASS
- Feature Completeness: 100/100
- Code Quality: 100/100
- Design Quality: 100/100
- Functionality: 100/100
- Restraint: 100/100`;
// The fake SDK falls back to call order, so park the sentinel entry far beyond any call a run makes:
// only a prompt that actually contains the front matter token can select it (via `when`).
const RUN_CALLS = (w) => {
  const calls = Array.from({ length: 30 }, () => ({ result: "done" }));
  calls[0] = { when: "Pinned Success Criteria", result: PASS };
  calls[15] = { when: "ZZ-FRONTMATTER-TOKEN", writeFiles: [{ path: w.marker, content: "leak" }], result: "leak" };
  return calls;
};

test("agent run: result.json and every ledger line carry agent; front matter never reaches a prompt", () => {
  const w = ws();
  const r = cli(w, ["--agent", w.file("a.md", VALID), "--mode", "build"], RUN_CALLS(w));
  const base = join(w.repo, ".hivekit", "runs");
  const runs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.equal(runs.length, 1, r.stdout + r.stderr);
  assert.match(runs[0], /test-agent/);
  const result = JSON.parse(readFileSync(join(base, runs[0], "result.json"), "utf-8"));
  assert.equal(result.agent, "test-agent");
  const lines = ledgerLines(w);
  assert.ok(lines.length > 0);
  assert.ok(lines.every((l) => l.agent === "test-agent"), JSON.stringify(lines));
  assert.equal(existsSync(w.marker), false, "front matter leaked into a prompt");
});

test("--intent run omits agent from result.json and the ledger", () => {
  const w = ws();
  const r = cli(w, ["--intent", w.file("HIVE.md", BODY), "--mode", "build"], RUN_CALLS(w));
  const base = join(w.repo, ".hivekit", "runs");
  const runs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.equal(runs.length, 1, r.stdout + r.stderr);
  const result = JSON.parse(readFileSync(join(base, runs[0], "result.json"), "utf-8"));
  assert.equal("agent" in result, false);
  assert.ok(ledgerLines(w).length > 0);
  assert.ok(ledgerLines(w).every((l) => !("agent" in l)));
});

test("the shipped example validates", () => {
  const w = ws();
  const r = cli(w, ["--agent", join(ROOT, "examples", "agents", "dependency-watch.md"), "--validate"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^agent dependency-watch: ok/);
});
