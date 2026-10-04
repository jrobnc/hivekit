import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { excludeFromGit, runsRoot, treeFingerprint } from "../dist/paths.js";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "hivekit-paths-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q");
  git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "."); git("commit", "-qm", "init");
  return { dir, git };
}

test("runsRoot is outside .claude/ (Claude Code refuses agent writes there)", () => {
  const root = runsRoot("/tmp/project");
  assert.equal(root, join("/tmp/project", ".hivekit", "runs"));
  assert.ok(!root.includes(".claude"));
});

test("excludeFromGit adds .hivekit/ to the local exclude once, and run files never show as untracked", async () => {
  const { dir, git } = repo();
  await excludeFromGit(dir);
  await excludeFromGit(dir);
  const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf-8");
  assert.equal(exclude.split("\n").filter((l) => l.trim() === ".hivekit/").length, 1);
  execFileSync("mkdir", ["-p", join(dir, ".hivekit", "runs", "r1")]);
  writeFileSync(join(dir, ".hivekit", "runs", "r1", "progress-1.md"), "x");
  assert.equal(git("status", "--porcelain").trim(), "");
});

test("excludeFromGit never throws outside a git repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hivekit-nogit-"));
  await assert.doesNotReject(excludeFromGit(dir));
});

test("treeFingerprint changes when the target changes, not when only run artifacts do", async () => {
  const { dir } = repo();
  await excludeFromGit(dir);
  const before = await treeFingerprint(dir);
  execFileSync("mkdir", ["-p", join(dir, ".hivekit", "runs", "r1")]);
  writeFileSync(join(dir, ".hivekit", "runs", "r1", "progress-1.md"), "notes");
  assert.equal(await treeFingerprint(dir), before, "run artifacts alone are not progress");
  writeFileSync(join(dir, "a.txt"), "two\n");
  assert.notEqual(await treeFingerprint(dir), before, "an edit to the target is progress");
});

test("treeFingerprint is undefined outside a git repository", async () => {
  assert.equal(await treeFingerprint(mkdtempSync(join(tmpdir(), "hivekit-nogit-"))), undefined);
});

test("treeFingerprint sees a second edit to an already-untracked file", async () => {
  const { dir } = repo();
  writeFileSync(join(dir, "new.txt"), "first\n");
  const before = await treeFingerprint(dir);
  writeFileSync(join(dir, "new.txt"), "second\n");
  assert.notEqual(await treeFingerprint(dir), before);
});

test("treeFingerprint works in a repository with no commits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hivekit-nohead-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const before = await treeFingerprint(dir);
  assert.ok(before !== undefined, "fingerprinted without HEAD");
  writeFileSync(join(dir, "a.txt"), "x\n");
  assert.notEqual(await treeFingerprint(dir), before);
});
