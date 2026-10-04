import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("subdirectory target: editing a file outside the subdirectory changes the fingerprint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hivekit-subdir-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q");
  git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "root file\n");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "b.txt"), "sub file\n");
  git("add", "."); git("commit", "-qm", "init");

  const sub = join(dir, "sub");
  await excludeFromGit(sub);
  const before = await treeFingerprint(sub);
  writeFileSync(join(dir, "a.txt"), "edited root file\n");
  assert.notEqual(await treeFingerprint(sub), before, "edit outside subdirectory must change the fingerprint");
});

test("subdirectory target: .hivekit/ artifacts under the subdirectory do not change the fingerprint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hivekit-subdir-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q");
  git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "root file\n");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "b.txt"), "sub file\n");
  git("add", "."); git("commit", "-qm", "init");

  const sub = join(dir, "sub");
  await excludeFromGit(sub);
  const before = await treeFingerprint(sub);
  mkdirSync(join(sub, ".hivekit", "runs", "r1"), { recursive: true });
  writeFileSync(join(sub, ".hivekit", "runs", "r1", "progress.md"), "notes");
  assert.equal(await treeFingerprint(sub), before, "run artifacts under subdirectory must not change the fingerprint");
});

test("subdirectory target: the exclude pathspec itself (no info/exclude) keeps sub/.hivekit artifacts out", async () => {
  const { dir, git } = repo();
  execFileSync("mkdir", ["-p", join(dir, "sub")]);
  writeFileSync(join(dir, "sub", "b.txt"), "b\n");
  git("add", "."); git("commit", "-qm", "sub");
  const sub = join(dir, "sub");
  // Deliberately NOT calling excludeFromGit: the pathspec must do the work on its own.
  const before = await treeFingerprint(sub);
  assert.notEqual(before, undefined, "fingerprinted (not vacuously equal)");
  execFileSync("mkdir", ["-p", join(sub, ".hivekit", "runs", "r1")]);
  writeFileSync(join(sub, ".hivekit", "runs", "r1", "progress-1.md"), "notes");
  assert.equal(await treeFingerprint(sub), before, "the target's own run artifacts are not progress");
  writeFileSync(join(dir, "a.txt"), "changed\n");
  assert.notEqual(await treeFingerprint(sub), before, "an edit elsewhere in the repo is progress");
});

test("a glob-looking directory name excludes only itself (literal pathspec)", async () => {
  const { dir, git } = repo();
  for (const d of ["a*b", "aXb"]) { execFileSync("mkdir", ["-p", join(dir, d)]); writeFileSync(join(dir, d, "f.txt"), "f\n"); }
  git("add", "."); git("commit", "-qm", "dirs");
  const target = join(dir, "a*b");
  const before = await treeFingerprint(target);
  assert.notEqual(before, undefined);
  execFileSync("mkdir", ["-p", join(dir, "aXb", ".hivekit")]);
  writeFileSync(join(dir, "aXb", ".hivekit", "other.md"), "another target's file");
  assert.notEqual(await treeFingerprint(target), before, "a sibling aXb/.hivekit is not excluded by a*b");
});
