// Tests for the HIVE.md parser. The only structured extraction the compiler does
// is Success Criteria + verifier tiers (they become the Evaluator's pinned rubric),
// so that's what's tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractSection,
  extractSuccessCriteria,
  formatCriteriaForEvaluator,
} from "../dist/intent.js";

const SAMPLE = `# HIVE.md

## Objective
Add a missed-dose indicator to the weekly grid.

## Success Criteria
- [auto] GET /api/doses/week returns a missed boolean per day; unit test covers a gap week.
- [judge] The marker reads as calm, not alarming.
- [human] Caregiver sign-off that the visual isn't anxiety-inducing.
- An untagged bullet that should default to human.

## Constraints
- Use the existing Supabase project.
`;

test("extractSection pulls a section body up to the next heading", () => {
  assert.equal(extractSection(SAMPLE, "Objective"), "Add a missed-dose indicator to the weekly grid.");
  assert.equal(extractSection(SAMPLE, "Constraints"), "- Use the existing Supabase project.");
});

test("extractSection is case-insensitive and returns empty for missing sections", () => {
  assert.equal(extractSection(SAMPLE, "objective"), "Add a missed-dose indicator to the weekly grid.");
  assert.equal(extractSection(SAMPLE, "Nonexistent"), "");
});

test("extractSuccessCriteria parses all three tiers", () => {
  const crits = extractSuccessCriteria(SAMPLE);
  assert.equal(crits.length, 4);
  assert.equal(crits[0].tier, "auto");
  assert.equal(crits[1].tier, "judge");
  assert.equal(crits[2].tier, "human");
  assert.ok(crits[0].text.startsWith("GET /api/doses/week"));
});

test("untagged criterion defaults to [human] (fail safe)", () => {
  const crits = extractSuccessCriteria(SAMPLE);
  const untagged = crits[3];
  assert.equal(untagged.tier, "human");
  assert.equal(untagged.text, "An untagged bullet that should default to human.");
});

test("tier tags are case-insensitive", () => {
  const crits = extractSuccessCriteria("## Success Criteria\n- [AUTO] x\n- [Judge] y");
  assert.equal(crits[0].tier, "auto");
  assert.equal(crits[1].tier, "judge");
});

test("no Success Criteria section yields an empty list", () => {
  assert.deepEqual(extractSuccessCriteria("## Objective\njust an objective"), []);
});

test("formatCriteriaForEvaluator is empty without intent (preserves bare-task behavior)", () => {
  assert.equal(formatCriteriaForEvaluator(undefined), "");
  assert.equal(formatCriteriaForEvaluator({ raw: "", objective: "", successCriteria: [] }), "");
});

test("formatCriteriaForEvaluator renders criteria + human-gate routing", () => {
  const out = formatCriteriaForEvaluator({
    raw: SAMPLE,
    objective: "x",
    successCriteria: extractSuccessCriteria(SAMPLE),
  });
  assert.ok(out.includes("grade against THESE"));
  assert.ok(out.includes("[human]"));
  assert.ok(out.includes("PENDING HUMAN SIGN-OFF"));
  assert.ok(out.includes("1. [auto]"));
});
