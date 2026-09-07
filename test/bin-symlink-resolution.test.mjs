import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Regression test for jrobnc/hivekit#6: `npm install` links
// node_modules/.bin/hivekit at ../hivekit/bin/hivekit, and the launcher used to
// derive its package root from the symlink's directory — so it looked for
// dist/index.js under node_modules/.bin/.. instead of the package root.
//
// Path strings alone can't catch that, so this builds the real consumer layout
// on disk — real symlinks, real launcher processes — but WITHOUT `npm install`,
// so the default suite stays offline and deterministic. The end-to-end
// `npm pack` + clean-install proof lives in test/network/packed-consumer.test.mjs
// and runs separately via `npm run test:packaged` (needs network).
//
// Layout built below, identical in shape to what npm links:
//   consumer/node_modules/hivekit          -> <repo root>
//   consumer/node_modules/.bin/hivekit     -> ../hivekit/bin/hivekit
//   consumer/node_modules/.bin/harness     -> ../hivekit/bin/harness
function makeConsumer() {
  const workdir = mkdtempSync(join(tmpdir(), "hivekit-symlink-"));
  const nodeModules = join(workdir, "consumer", "node_modules");
  mkdirSync(join(nodeModules, ".bin"), { recursive: true });
  symlinkSync(repoRoot, join(nodeModules, "hivekit"));
  for (const name of ["hivekit", "harness"]) {
    symlinkSync(join("..", "hivekit", "bin", name), join(nodeModules, ".bin", name));
  }
  return { workdir, nodeModules };
}

test("launchers resolve the package root through real node_modules/.bin symlinks", () => {
  assert.ok(
    existsSync(join(repoRoot, "dist", "index.js")),
    "dist/index.js must be built before this test — run `npm run build`"
  );

  const { workdir, nodeModules } = makeConsumer();
  try {
    const binLink = join(nodeModules, ".bin", "hivekit");
    assert.ok(
      lstatSync(binLink).isSymbolicLink(),
      "node_modules/.bin/hivekit must be a real symlink — otherwise this test proves nothing"
    );

    // Every launcher path a consumer can reach must find dist/index.js.
    const launchers = {
      "node_modules/.bin/hivekit": binLink,
      "node_modules/.bin/harness": join(nodeModules, ".bin", "harness"),
      "node_modules/hivekit/bin/hivekit": join(nodeModules, "hivekit", "bin", "hivekit"),
      "node_modules/hivekit/bin/harness": join(nodeModules, "hivekit", "bin", "harness"),
    };

    for (const [label, launcher] of Object.entries(launchers)) {
      const run = spawnSync(launcher, ["--help"], { cwd: workdir, encoding: "utf8" });
      assert.equal(run.status, 0, `${label} --help exited ${run.status}: ${run.stderr}`);
      assert.match(run.stdout, /Usage: hivekit/, `${label} --help did not print usage`);
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("an over-long symlink chain fails with a clear message instead of looping", () => {
  const workdir = mkdtempSync(join(tmpdir(), "hivekit-symlink-depth-"));
  try {
    // A true cycle can never be exec'd (the kernel ELOOPs first), so the
    // reachable form of the same hazard is an over-long chain: build 25 hops,
    // more than the launcher's own MAX_SYMLINK_HOPS but still under the OS cap.
    for (const name of ["hivekit", "harness"]) {
      let previous = join(repoRoot, "bin", name);
      for (let hop = 0; hop < 25; hop += 1) {
        const link = join(workdir, `${name}-${hop}`);
        symlinkSync(previous, link);
        previous = link;
      }

      const run = spawnSync(previous, ["--help"], {
        cwd: workdir,
        encoding: "utf8",
        timeout: 20_000,
      });
      assert.notEqual(run.signal, "SIGTERM", `bin/${name} hung on an over-long symlink chain`);
      assert.notEqual(run.status, 0, `bin/${name} should fail on an over-long symlink chain`);
      assert.match(
        run.stderr,
        /symlinks while resolving launcher path/,
        `bin/${name} did not explain the symlink failure: ${run.stderr}`
      );
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
