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

/**
 * A fingerprint of the target's working tree (status + diff against HEAD, run artifacts excluded), or undefined when
 * the target is not a git repository. Two equal fingerprints mean the agents changed nothing.
 */
export async function treeFingerprint(cwd: string): Promise<string | undefined> {
  try {
    const exclude = ":(exclude).hivekit";
    const [status, diff] = await Promise.all([
      run("git", ["status", "--porcelain", "--untracked-files=all", "--", ".", exclude], { cwd, maxBuffer: 64 * 1024 * 1024 }),
      run("git", ["diff", "HEAD", "--", ".", exclude], { cwd, maxBuffer: 256 * 1024 * 1024 }),
    ]);
    const { stdout: head } = await run("git", ["rev-parse", "HEAD"], { cwd });
    return `${head.trim()}\n${status.stdout}\n${diff.stdout}`;
  } catch {
    return undefined;
  }
}
