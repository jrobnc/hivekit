import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Isolate HOME before any import: the ledger path is fixed at module load.
const home = mkdtempSync(join(tmpdir(), "hivekit-home-"));
process.env.HOME = home;
const { jevYesNo, maskForJev, advise } = await import("../dist/advisor.js");

// None of these cases may reach the network: each returns null before fetch.
test("jev is off unless HIVEKIT_JEV=1, even with a key", async () => {
  process.env.JEV_API_KEY = "test-key";
  delete process.env.HIVEKIT_JEV;
  assert.equal(await jevYesNo("state", "question?"), null);
});

test("jev returns null without a key", async () => {
  process.env.HIVEKIT_JEV = "1";
  delete process.env.JEV_API_KEY;
  assert.equal(await jevYesNo("state", "question?"), null);
});

test("jev stops at the ledger budget", async () => {
  process.env.HIVEKIT_JEV = "1";
  process.env.JEV_API_KEY = "test-key";
  mkdirSync(join(home, ".cache", "hivekit"), { recursive: true });
  writeFileSync(join(home, ".cache", "hivekit", "ledger.jsonl"), JSON.stringify({ label: "jev", usd: 25 }) + "\n");
  assert.equal(await jevYesNo("state", "question?"), null);
});

test("maskForJev masks emails and phones and caps length", () => {
  const out = maskForJev("mail jane.doe@acme.co.uk or call +1 (617) 555-0100 now");
  assert.equal(out, "mail [email] or call [phone] now");
  assert.equal(maskForJev("x".repeat(9000)).length, 4000);
});

test("advisor can be switched off without spending", async () => {
  process.env.HIVEKIT_ADVISOR = "0";
  assert.deepEqual(await advise("plan", process.cwd(), ""), { ok: true, note: "advisor off" });
});
