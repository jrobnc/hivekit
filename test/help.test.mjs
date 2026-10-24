import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("--help documents --check and HIVEKIT_CHECK_ENV_KEEP", () => {
  const out = execFileSync("node", [join(root, "dist", "index.js"), "--help"], { encoding: "utf-8" });
  assert.match(out, /--check/);
  assert.match(out, /HIVEKIT_CHECK_ENV_KEEP/);
});

test("bin/hivekit --help shows the same", () => {
  const out = execFileSync("bash", [join(root, "bin", "hivekit"), "--help"], {
    encoding: "utf-8",
    env: { ...process.env, HIVEKIT_ALLOW_NO_TOKEN: "1" },
  });
  assert.match(out, /--check/);
  assert.match(out, /HIVEKIT_CHECK_ENV_KEEP/);
});
