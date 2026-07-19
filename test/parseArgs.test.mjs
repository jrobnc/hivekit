// Tests for CLI argument parsing error paths.
// These invoke `node dist/index.js` as a subprocess — the process.exit(1) guards
// fire before any orchestrator logic runs, so no agent SDK is needed.
//
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const CLI = resolve(import.meta.dirname, "..", "dist", "index.js");

function run(args) {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("--mode as last arg (no value) exits non-zero", () => {
  const { code, stderr } = run(["--mode"]);
  assert.equal(code, 1);
  assert.match(stderr || "", /--mode requires a value/);
});

test("--cwd as last arg (no value) exits non-zero", () => {
  const { code, stderr } = run(["--cwd"]);
  assert.equal(code, 1);
  assert.match(stderr || "", /--cwd requires a value/);
});

test("unknown --flag exits non-zero", () => {
  const { code, stderr } = run(["--focsus"]);
  assert.equal(code, 1);
  assert.match(stderr || "", /unknown flag --focsus/);
});

test("--sprint abc exits non-zero with helpful error", () => {
  const { code, stderr } = run(["--sprint", "abc"]);
  assert.equal(code, 1);
  assert.match(stderr || "", /--sprint requires a numeric value/);
});

test("--max-turns abc exits non-zero with helpful error", () => {
  const { code, stderr } = run(["--max-turns", "abc"]);
  assert.equal(code, 1);
  assert.match(stderr || "", /--max-turns requires a numeric value/);
});

test("--help exits 0 (valid args baseline)", () => {
  const { code } = run(["--help"]);
  assert.equal(code, 0);
});
