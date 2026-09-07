import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Canonicalise the temp root before anything is built inside it. On a stock
// macOS, tmpdir() is /var/folders/... and /var is itself a symlink to
// /private/var, so every absolute path under it costs an extra symlink
// resolution on every lookup. That silently doubles the cost of the symlink
// chain built below and pushes it past the kernel's own ceiling. Resolving the
// root once here keeps one chain link worth exactly one symlink hop.
const tmpRoot = realpathSync(tmpdir());

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
  const workdir = mkdtempSync(join(tmpRoot, "hivekit-symlink-"));
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

// The launcher caps its own walk at MAX_SYMLINK_HOPS=20. The kernel caps an
// exec's path resolution at SYMLOOP_MAX, which is 32 on macOS and 40 on Linux.
// The chain has to sit strictly between the two: long enough that the
// launcher's guard is what stops the walk, short enough that the kernel can
// still exec the launcher at all. 25 hops satisfies both on every supported
// platform — provided each link costs exactly one hop, which is what the
// canonical tmpRoot above buys us.
const CHAIN_HOPS = 25;

test("an over-long symlink chain fails with a clear message instead of looping", () => {
  const workdir = mkdtempSync(join(tmpRoot, "hivekit-symlink-depth-"));
  try {
    // A true cycle can never be exec'd (the kernel ELOOPs first), so the
    // reachable form of the same hazard is an over-long chain.
    for (const name of ["hivekit", "harness"]) {
      let previous = join(repoRoot, "bin", name);
      for (let hop = 0; hop < CHAIN_HOPS; hop += 1) {
        const link = join(workdir, `${name}-${hop}`);
        symlinkSync(previous, link);
        previous = link;
      }

      const run = spawnSync(previous, ["--help"], {
        cwd: workdir,
        encoding: "utf8",
        timeout: 20_000,
      });

      // Four separate things have to hold, and each has its own failure mode.
      // 1. It did not hang.
      assert.notEqual(run.signal, "SIGTERM", `bin/${name} hung on an over-long symlink chain`);
      // 2. The launcher actually started. If the kernel ELOOPs during exec, the
      //    guard never runs and the rest of this test would be vacuous, so fail
      //    loudly and say why rather than passing on a technicality.
      assert.equal(
        run.error,
        undefined,
        `bin/${name} never started (${run.error?.code}) — the chain hit the kernel's own ` +
          `symlink ceiling before bash opened the launcher, so MAX_SYMLINK_HOPS was never exercised`
      );
      assert.equal(
        typeof run.status,
        "number",
        `bin/${name} produced no exit status, so the launcher never ran`
      );
      // 3. The guard failed the run.
      assert.notEqual(run.status, 0, `bin/${name} should fail on an over-long symlink chain`);
      // 4. The guard, and not something else, is what reported the failure.
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
