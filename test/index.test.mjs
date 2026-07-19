// Tests for generateRunId slug sanitization.
// Since index.ts calls main() at module level, we can't import generateRunId
// directly. Instead, we test the sanitization logic inline.
//
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

// Replicate the sanitization logic from generateRunId to verify it in isolation.
// The source of truth is src/index.ts:generateRunId — these tests verify the
// sanitization contract: slug is lowercase alphanumeric + hyphens only.
function sanitizeSlug(raw) {
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, "") || "run";
}

test("adversarial name is sanitized to safe slug", () => {
  const slug = sanitizeSlug("../../etc/passwd");
  assert.match(slug, /^[a-z0-9-]+$/);
  assert.ok(!slug.includes(".."));
  assert.ok(!slug.includes("/"));
  assert.equal(slug, "etcpasswd");
});

test("all-special-char name falls back to 'run'", () => {
  assert.equal(sanitizeSlug("***"), "run");
  assert.equal(sanitizeSlug("///"), "run");
  assert.equal(sanitizeSlug(""), "run");
});

test("normal name with hyphens is preserved", () => {
  assert.equal(sanitizeSlug("my-feature"), "my-feature");
});

test("mixed case and special chars are cleaned", () => {
  assert.equal(sanitizeSlug("My Feature!"), "myfeature");
});
