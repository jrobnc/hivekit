import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
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

test("bin/hivekit warns on stderr when HARNESS_ALLOW_API_KEY is set and preserves ANTHROPIC_API_KEY", () => {
  const fakeNodeDir = mkdtempSync(join(tmpdir(), "hivekit-fake-node-"));
  const fakeNode = join(fakeNodeDir, "node");
  writeFileSync(fakeNode, "#!/usr/bin/env bash\nenv\n");
  chmodSync(fakeNode, 0o755);

  try {
    const result = execFileSync("bash", [hivekitBin, "--help"], {
      env: {
        ...process.env,
        PATH: `${fakeNodeDir}:${process.env.PATH}`,
        HARNESS_ALLOW_API_KEY: "1",
        ANTHROPIC_API_KEY: "sk-test-key",
      },
      encoding: "utf-8",
      // exec replaces process so stderr comes from the echo before exec
      // We need to capture stderr separately
    });

    // When HARNESS_ALLOW_API_KEY is set, ANTHROPIC_API_KEY must survive
    assert.ok(
      result.includes("ANTHROPIC_API_KEY=sk-test-key"),
      "ANTHROPIC_API_KEY must survive when HARNESS_ALLOW_API_KEY is set"
    );
  } finally {
    rmSync(fakeNodeDir, { recursive: true, force: true });
  }
});

test("bin/hivekit HARNESS_ALLOW_API_KEY warning appears on stderr", () => {
  const fakeNodeDir = mkdtempSync(join(tmpdir(), "hivekit-fake-node-"));
  const fakeNode = join(fakeNodeDir, "node");
  writeFileSync(fakeNode, "#!/usr/bin/env bash\nenv\n");
  chmodSync(fakeNode, 0o755);

  try {
    const proc = spawnSync("bash", [hivekitBin, "--help"], {
      env: {
        ...process.env,
        PATH: `${fakeNodeDir}:${process.env.PATH}`,
        HARNESS_ALLOW_API_KEY: "1",
        ANTHROPIC_API_KEY: "sk-test-key",
      },
      encoding: "utf-8",
    });

    assert.ok(
      proc.stderr.includes("WARNING: HARNESS_ALLOW_API_KEY is set"),
      `expected warning on stderr, got: ${proc.stderr}`
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
    // Drop the developer's own override so the test doesn't depend on their shell.
    const { HARNESS_ALLOW_API_KEY: _ignored, ...cleanEnv } = process.env;
    const output = execFileSync("bash", [hivekitBin, "--help"], {
      env: {
        ...cleanEnv,
        PATH: `${fakeNodeDir}:${process.env.PATH}`,
        ANTHROPIC_API_KEY: "sk-should-not-leak",
        ANTHROPIC_AUTH_TOKEN: "tok-should-not-leak",
        HIVEKIT_ALLOW_NO_TOKEN: "1",
      },
      encoding: "utf-8",
    });

    assert.ok(
      !output.includes("ANTHROPIC_API_KEY="),
      "ANTHROPIC_API_KEY must still be stripped by default"
    );
    assert.ok(
      !output.includes("ANTHROPIC_AUTH_TOKEN="),
      "ANTHROPIC_AUTH_TOKEN must be stripped by default"
    );
  } finally {
    rmSync(fakeNodeDir, { recursive: true, force: true });
  }
});

// --- fail-fast when no OAuth token resolves ---------------------------------

function runLauncherNoToken(extraEnv, { security = "#!/usr/bin/env bash\nexit 1\n", credentialsFile = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hivekit-fake-node-"));
  // Empty HOME so a developer's real ~/.claude/.credentials.json can't satisfy the guard.
  const home = mkdtempSync(join(tmpdir(), "hivekit-fake-home-"));
  writeFileSync(join(dir, "node"), "#!/usr/bin/env bash\nenv\n");
  // Fake `security` so a developer Mac's real Keychain can't supply a token.
  writeFileSync(join(dir, "security"), security);
  chmodSync(join(dir, "node"), 0o755);
  chmodSync(join(dir, "security"), 0o755);
  if (credentialsFile) {
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
  }
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOME: home };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.HARNESS_ALLOW_API_KEY;
  delete env.HIVEKIT_ALLOW_NO_TOKEN;
  try {
    return spawnSync("bash", [hivekitBin, "--help"], {
      env: { ...env, ...extraEnv },
      encoding: "utf-8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

test("bin/hivekit exits 3 with a clear message when no OAuth token resolves", () => {
  const proc = runLauncherNoToken({});
  assert.equal(proc.status, 3, `stderr: ${proc.stderr}`);
  assert.match(proc.stderr, /claude \/login/);
  assert.match(proc.stderr, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(proc.stderr, /\.credentials\.json/);
  assert.ok(!proc.stdout.includes("PATH="), "node must not have been exec'd");
});

test("bin/hivekit proceeds when CLAUDE_CODE_OAUTH_TOKEN is set", () => {
  const proc = runLauncherNoToken({ CLAUDE_CODE_OAUTH_TOKEN: "tok" });
  assert.equal(proc.status, 0, `stderr: ${proc.stderr}`);
  assert.ok(proc.stdout.includes("CLAUDE_CODE_OAUTH_TOKEN=tok"));
});

test("bin/hivekit proceeds with HIVEKIT_ALLOW_NO_TOKEN=1 and no token", () => {
  const proc = runLauncherNoToken({ HIVEKIT_ALLOW_NO_TOKEN: "1" });
  assert.equal(proc.status, 0, `stderr: ${proc.stderr}`);
  assert.ok(proc.stdout.includes("PATH="));
});

test("bin/hivekit exits 3 when the Keychain holds a null accessToken", () => {
  const proc = runLauncherNoToken({}, {
    security: `#!/usr/bin/env bash\necho '{"claudeAiOauth":{"accessToken":null}}'\n`,
  });
  assert.equal(proc.status, 3, `stderr: ${proc.stderr}`);
  assert.ok(!proc.stdout.includes("PATH="), "node must not have been exec'd");
});

test("bin/hivekit proceeds when ~/.claude/.credentials.json exists (non-macOS)", () => {
  const proc = runLauncherNoToken({}, { credentialsFile: true });
  assert.equal(proc.status, 0, `stderr: ${proc.stderr}`);
  assert.ok(proc.stdout.includes("PATH="));
});

test("bin/hivekit skips the token check for a non-claude provider but still strips ANTHROPIC_API_KEY", () => {
  const proc = runLauncherNoToken({ HIVEKIT_PROVIDER: "openai-compatible", ANTHROPIC_API_KEY: "sk-test" });
  assert.equal(proc.status, 0, `stderr: ${proc.stderr}`);
  assert.ok(proc.stdout.includes("PATH="), "node must have been exec'd");
  assert.ok(!proc.stdout.includes("ANTHROPIC_API_KEY="));
});

test("bin/hivekit does not read the Keychain for a non-claude provider", () => {
  const proc = runLauncherNoToken({ HIVEKIT_PROVIDER: "openai-compatible" }, {
    security: `#!/usr/bin/env bash\necho '{"claudeAiOauth":{"accessToken":"kc-secret"}}'\n`,
  });
  assert.equal(proc.status, 0, `stderr: ${proc.stderr}`);
  assert.ok(proc.stdout.includes("PATH="));
  assert.ok(!proc.stdout.includes("kc-secret"));
});
