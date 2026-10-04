import { execFile } from "child_process";
import { appendFile, mkdir, readFile } from "fs/promises";
import { dirname, isAbsolute, join } from "path";
import { promisify } from "util";

const run = promisify(execFile);

/**
 * Where a run's artifacts live in the target project: `<cwd>/.hivekit/runs/`.
 *
 * Not `.claude/`: Claude Code protects `.claude/` from agent writes, so the improve agents' progress files and the
 * evaluator's notes were silently refused there. HiveKit then read "no progress" for agents that had changed the
 * code (aborting finished work) and the evaluator opened its reply with the refusal instead of the verdict.
 */
export function runsRoot(cwd: string): string {
  return join(cwd, ".hivekit", "runs");
}

/**
 * Keep `.hivekit/` out of the target's commits without touching its tracked files: add it to the repository's
 * local exclude file (`git rev-parse --git-path info/exclude`, so worktrees work). Never throws — a target that is
 * not a git repository, or a read-only exclude file, just goes without.
 */
export async function excludeFromGit(cwd: string): Promise<void> {
  try {
    const { stdout } = await run("git", ["rev-parse", "--git-path", "info/exclude"], { cwd });
    const rel = stdout.trim();
    if (!rel) return;
    const path = isAbsolute(rel) ? rel : join(cwd, rel);
    let current = "";
    try { current = await readFile(path, "utf-8"); } catch { /* no exclude file yet */ }
    if (current.split(/\r?\n/).some((line) => line.trim() === ".hivekit/" || line.trim() === "/.hivekit/")) return;
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${current === "" || current.endsWith("\n") ? "" : "\n"}.hivekit/\n`, "utf-8");
  } catch {
    /* not a git repository, or no permission: nothing to do */
  }
}

/** Git's empty tree: the diff base for a repository with no commits yet. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * A fingerprint of the target's working tree, or undefined when the target is not a git repository. Two equal
 * fingerprints mean the agents changed nothing. It covers: HEAD; `git status`; the binary-safe diff against HEAD (or
 * the empty tree before the first commit), ignoring the user's external diff and textconv drivers; and the CONTENT of
 * untracked files (status alone shows `?? file` both before and after an edit to an already-untracked file). Run
 * artifacts under `.hivekit/` are excluded. Scope is the target directory: with a subdirectory as the target, edits
 * outside it are not seen, and the run falls back to the plain "no progress" abort — never to a false pass.
 */
export async function treeFingerprint(cwd: string): Promise<string | undefined> {
  try {
    await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  } catch {
    return undefined;
  }
  try {
    const exclude = ":(exclude).hivekit";
    let head = "";
    try { head = (await run("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim(); } catch { /* no commits yet */ }
    const base = head || EMPTY_TREE;
    const [status, diff, untracked] = await Promise.all([
      run("git", ["status", "--porcelain", "--untracked-files=all", "--", ".", exclude], { cwd, maxBuffer: 64 * 1024 * 1024 }),
      run("git", ["diff", "--binary", "--no-ext-diff", "--no-textconv", base, "--", ".", exclude], { cwd, maxBuffer: 256 * 1024 * 1024 }),
      run("git", ["ls-files", "-o", "--exclude-standard", "-z", "--", ".", exclude], { cwd, maxBuffer: 64 * 1024 * 1024 }),
    ]);
    const files = untracked.stdout.split("\0").filter(Boolean);
    const hashes: string[] = [];
    for (let i = 0; i < files.length; i += 500) {
      hashes.push((await run("git", ["hash-object", "--", ...files.slice(i, i + 500)], { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout);
    }
    return `${head || "(no commits)"}\n${status.stdout}\n${diff.stdout}\n${hashes.join("")}`;
  } catch {
    return undefined;
  }
}
