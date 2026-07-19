// Tests for sdk-utils helpers.
//
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fillTemplate } from "../dist/sdk-utils.js";

test("fillTemplate with missing key preserves {{missing}} in output", () => {
  const result = fillTemplate("Hello {{name}}, welcome to {{place}}!", {
    name: "Alice",
  });
  assert.equal(result, "Hello Alice, welcome to {{place}}!");
  assert.ok(result.includes("{{place}}"));
});

test("fillTemplate with all keys filled leaves no placeholders", () => {
  const result = fillTemplate("{{a}} and {{b}}", { a: "1", b: "2" });
  assert.equal(result, "1 and 2");
  assert.ok(!result.includes("{{"));
});
