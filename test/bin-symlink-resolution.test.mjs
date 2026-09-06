import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Regression test for jrobnc/hivekit#6: `npm install` links
// node_modules/.bin/hivekit at ../hivekit/bin/hivekit, and the launcher used to
// derive its package root from the symlink's directory — so it looked for
// dist/index.js under node_modules/.bin/.. instead of the package root. Path
// strings alone can't catch that, so this builds a real consumer: `npm pack`
// the package and `npm install` the resulting tarball into a throwaway project.
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
