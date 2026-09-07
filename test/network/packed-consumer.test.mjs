import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// NETWORK-ENABLED verification for jrobnc/hivekit#6 — NOT part of `npm test`.
// Run it with `npm run test:packaged`; it needs registry access because the
// `npm install` of the packed tarball resolves the runtime dependency.
//
// This is the end-to-end proof: `npm pack` the package and `npm install` the
// resulting tarball into a throwaway project, so npm itself creates the
// node_modules/.bin symlinks. The offline half of the same regression lives in
// test/bin-symlink-resolution.test.mjs, which builds the symlink shape by hand
// and runs under the default suite.
test("packed consumer can launch hivekit through the node_modules/.bin symlink", () => {
  assert.ok(
    existsSync(join(repoRoot, "dist", "index.js")),
    "dist/index.js must be built before packing — run `npm run build`"
  );

  const workdir = mkdtempSync(join(tmpdir(), "hivekit-consumer-"));
  const consumer = join(workdir, "consumer");
  mkdirSync(consumer);

  try {
    const packed = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", workdir],
        { cwd: repoRoot, encoding: "utf8" }
      )
    )[0];
    const tarball = join(workdir, packed.filename);

    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ name: "hivekit-consumer-fixture", version: "1.0.0", private: true })
    );
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", tarball], {
      cwd: consumer,
      encoding: "utf8",
    });

    const binLink = join(consumer, "node_modules", ".bin", "hivekit");
    assert.ok(
      lstatSync(binLink).isSymbolicLink(),
      "npm must have linked node_modules/.bin/hivekit — otherwise this test proves nothing"
    );

    // Every launcher path a consumer can reach must find dist/index.js.
    const launchers = {
      "node_modules/.bin/hivekit": binLink,
      "node_modules/.bin/harness": join(consumer, "node_modules", ".bin", "harness"),
      "node_modules/hivekit/bin/hivekit": join(consumer, "node_modules", "hivekit", "bin", "hivekit"),
    };

    for (const [label, launcher] of Object.entries(launchers)) {
      const run = spawnSync(launcher, ["--help"], { cwd: consumer, encoding: "utf8" });
      assert.equal(run.status, 0, `${label} --help exited ${run.status}: ${run.stderr}`);
      assert.match(run.stdout, /Usage: hivekit/, `${label} --help did not print usage`);
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
