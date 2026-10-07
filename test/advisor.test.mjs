import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// No key anywhere -> Jev reports "unsure" (null) so the caller escalates; it never throws.
test("jevYesNo returns null without a key", async () => {
  delete process.env.JEV_API_KEY;
  process.env.HOME = mkdtempSync(join(tmpdir(), "hivekit-nokey-"));
  const { jevYesNo } = await import("../dist/advisor.js");
  assert.equal(await jevYesNo("state", "question?"), null);
});

test("advisor can be switched off without spending", async () => {
  process.env.HIVEKIT_ADVISOR = "0";
  const { advise } = await import("../dist/advisor.js");
  assert.deepEqual(await advise("plan", process.cwd(), ""), { ok: true, note: "advisor off" });
});
