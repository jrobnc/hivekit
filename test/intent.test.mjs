// Tests for the HIVE.md parser. The only structured extraction the compiler does
// is Success Criteria + verifier tiers (they become the Evaluator's pinned rubric),
// so that's what's tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractSection,
  extractSuccessCriteria,
  formatCriteriaForEvaluator,
  toIntentYaml,
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
  assert.ok(out.includes("1. [auto")); // "[auto (unverified)]" when there is no command
});

test("toIntentYaml emits structured objective + tiered criteria + constraints", () => {
  const yaml = toIntentYaml({
    raw: SAMPLE,
    objective: extractSection(SAMPLE, "Objective"),
    successCriteria: extractSuccessCriteria(SAMPLE),
  });
  assert.ok(yaml.includes("objective: |"));
  assert.ok(yaml.includes("success_criteria:"));
  assert.ok(yaml.includes("- tier: auto"));
  assert.ok(yaml.includes("- tier: judge"));
  assert.ok(yaml.includes("- tier: human"));        // explicit + the untagged-default one
  assert.ok(yaml.includes("constraints: |"));
  assert.ok(yaml.includes("Use the existing Supabase project"));
});

test("toIntentYaml escapes quotes/backslashes in criterion text (valid YAML scalars)", () => {
  const yaml = toIntentYaml({
    raw: "",
    objective: "x",
    successCriteria: [{ tier: "auto", text: 'has a "quote" and a \\ backslash' }],
  });
  // double-quoted scalar with both escaped
  assert.ok(yaml.includes('\\"quote\\"'));
  assert.ok(yaml.includes("\\\\ backslash"));
});

test("toIntentYaml renders empty criteria as a flow-empty list", () => {
  const yaml = toIntentYaml({ raw: "", objective: "x", successCriteria: [] });
  assert.ok(yaml.includes("success_criteria: []"));
});

// ── [auto] executable checks ─────────────────────────────────────────
import { parseIntent, loadIntent } from "../dist/intent.js";

const doc = (body) => `## Success Criteria\n${body}\n`;

test("backtick form sets command and strips it from text", (t) => {
  t.mock.method(console, "warn", () => {});
  const c = parseIntent(doc("- [auto] tests pass: `npm test`")).successCriteria;
  assert.deepEqual(c, [{ tier: "auto", text: "tests pass", command: "npm test" }]);
});

test("fenced check block holds a multi-line command; text excludes the fence", (t) => {
  t.mock.method(console, "warn", () => {});
  const c = parseIntent(doc("- [auto] full suite passes\n  ```check\n  npm ci\n  npm test\n  ```\n- [human] next")).successCriteria;
  assert.equal(c[0].command, "npm ci\nnpm test");
  assert.equal(c[0].text, "full suite passes");
  assert.equal(c.length, 2);
});

test("[auto] without a command is unverified: no command key, one WARN", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const c = parseIntent(doc("- [auto] it works")).successCriteria;
  assert.deepEqual(c, [{ tier: "auto", text: "it works" }]);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /auto \(unverified\)/);
});

test("check fence under [judge] is ignored with one WARN", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const c = parseIntent(doc("- [judge] looks calm\n  ```check\n  echo hi\n  ```")).successCriteria;
  assert.deepEqual(c, [{ tier: "judge", text: "looks calm" }]);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /ignored/);
});

test("unterminated check fence fails closed to unverified", (t) => {
  t.mock.method(console, "warn", () => {});
  const c = parseIntent(doc("- [auto] x\n  ```check\n  rm -rf /")).successCriteria;
  assert.deepEqual(c, [{ tier: "auto", text: "x" }]);
});

test("unterminated check fence shields nothing: later bullets (and their commands) still parse", (t) => {
  t.mock.method(console, "warn", () => {});
  const c = parseIntent(doc("- [auto] a\n  ```check\n  echo a\n- [human] owner signs off\n- [auto] b: `true`")).successCriteria;
  assert.deepEqual(c, [
    { tier: "auto", text: "a" },
    { tier: "human", text: "owner signs off" },
    { tier: "auto", text: "b", command: "true" },
  ]);
});

test("unterminated top-level fence warns and shields nothing", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const c = parseIntent(doc("```md\n- [human] y\n- [auto] z: `true`")).successCriteria;
  assert.deepEqual(c, [{ tier: "human", text: "y" }, { tier: "auto", text: "z", command: "true" }]);
  assert.match(warn.mock.calls[0].arguments[0], /unterminated fence/);
});

test("check fence with a CommonMark info string parses; closing fence is not an opener", (t) => {
  t.mock.method(console, "warn", () => {});
  const c = parseIntent(doc("- [auto] x\n  ```check title\n  echo hi\n  ```\n- [human] y\n```sh title=\"x\"\n- [auto] fake\n```\n- [human] z")).successCriteria;
  assert.deepEqual(c, [
    { tier: "auto", text: "x", command: "echo hi" },
    { tier: "human", text: "y" },
    { tier: "human", text: "z" },
  ]);
});

test("continuation lines join; fenced bullets are not criteria", (t) => {
  t.mock.method(console, "warn", () => {});
  const c = parseIntent(doc("- [auto] suite passes\n  on CI: `npm test`\n```md\n- [auto] fake\n```\n- [human] ok")).successCriteria;
  assert.deepEqual(c, [
    { tier: "auto", text: "suite passes on CI", command: "npm test" },
    { tier: "human", text: "ok" },
  ]);
});

test("toIntentYaml emits command; loadIntent is exported", (t) => {
  t.mock.method(console, "warn", () => {});
  assert.match(toIntentYaml(parseIntent(doc("- [auto] a: `x`"))), /command: "x"/);
  assert.equal(typeof loadIntent, "function");
});

test("formatCriteriaForEvaluator hands over hivekit's transcript as the only evidence", (t) => {
  t.mock.method(console, "warn", () => {});
  const intent = parseIntent(doc("- [auto] fails: `exit 3`"));
  const out = formatCriteriaForEvaluator(intent, [
    { index: 1, text: "fails", command: "exit 3", exitCode: 3, timedOut: false, durationMs: 5, stdoutTail: "a ``` b", stderrTail: "" },
  ]);
  assert.match(out, /exit 3/);
  assert.match(out, /only admissible evidence/i);
  assert.ok(out.includes("````\na ``` b\n````"), "fence outgrows backticks in the output");
  assert.match(formatCriteriaForEvaluator(intent), /NO TRANSCRIPT/);
});
