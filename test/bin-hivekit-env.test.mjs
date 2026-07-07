import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const hivekitBin = join(__dirname, "..", "bin", "hivekit");

test("bin/hivekit strips parent Claude Code session env vars before exec'ing node", () => {
  // Put a fake `node` ahead of the real one on PATH. It just dumps its env,
  // so we can see exactly what bin/hivekit passed through — no real agent
  // run, no dist/index.js required, no network calls.
  const fakeNodeDir = mkdtempSync(join(tmpdir(), "hivekit-fake-node-"));
  const fakeNode = join(fakeNodeDir, "node");
  writeFileSync(fakeNode, "#!/usr/bin/env bash\nenv\n");
  chmodSync(fakeNode, 0o755);

  try {
    const output = execFileSync("bash", [hivekitBin, "--help"], {
      env: {
        ...process.env,
        PATH: `${fakeNodeDir}:${process.env.PATH}`,
        // Simulates the env a nested `claude` subprocess inherits when
        // hivekit is invoked from inside an already-running Claude Code
        // session (e.g. via its Bash tool).
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "parent-session-id",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        CLAUDE_CODE_EXECPATH: "/some/path/claude.exe",
        CLAUDE_CODE_CHILD_SESSION: "1",
        CLAUDE_EFFORT: "high",
        ANTHROPIC_MODEL: "claude-sonnet-4-6",
        AI_AGENT: "claude-code_2-1-197_agent",
        // Must survive — this is the actual credential the subprocess needs.
        CLAUDE_CODE_OAUTH_TOKEN: "keep-me",
      },
      encoding: "utf-8",
    });

    for (const leaked of [
      "CLAUDECODE=",
      "CLAUDE_CODE_SESSION_ID=",
      "CLAUDE_CODE_ENTRYPOINT=",
      "CLAUDE_CODE_EXECPATH=",
      "CLAUDE_CODE_CHILD_SESSION=",
      "CLAUDE_EFFORT=",
      "ANTHROPIC_MODEL=",
      "AI_AGENT=",
    ]) {
      assert.ok(
        !output.includes(leaked),
        `expected ${leaked} to be stripped, but it leaked into the child env`
      );
    }
    assert.ok(
      output.includes("CLAUDE_CODE_OAUTH_TOKEN=keep-me"),
      "CLAUDE_CODE_OAUTH_TOKEN must NOT be stripped — it's the OAuth credential"
    );
  } finally {
    rmSync(fakeNodeDir, { recursive: true, force: true });
  }
});

test("bin/hivekit still strips ANTHROPIC_API_KEY (existing behavior, no regression)", () => {
  const fakeNodeDir = mkdtempSync(join(tmpdir(), "hivekit-fake-node-"));
  const fakeNode = join(fakeNodeDir, "node");
  writeFileSync(fakeNode, "#!/usr/bin/env bash\nenv\n");
  chmodSync(fakeNode, 0o755);

  try {
    const output = execFileSync("bash", [hivekitBin, "--help"], {
      env: {
        ...process.env,
        PATH: `${fakeNodeDir}:${process.env.PATH}`,
        ANTHROPIC_API_KEY: "sk-should-not-leak",
      },
      encoding: "utf-8",
    });

    assert.ok(
      !output.includes("ANTHROPIC_API_KEY="),
      "ANTHROPIC_API_KEY must still be stripped by default"
    );
  } finally {
    rmSync(fakeNodeDir, { recursive: true, force: true });
  }
});
