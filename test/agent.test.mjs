import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgent } from "../dist/agent.js";
import { parseIntent } from "../dist/intent.js";

const BODY = `## Objective
Watch deps.

## Success Criteria
- [auto] report: \`test -f r.md\`
- [judge] reads well
`;
const mk = (fm, body = BODY) => `---\nname: my-agent\n${fm}\n---\n${body}`;
const errs = (raw) => { const r = parseAgent(raw); assert.equal(r.ok, false, JSON.stringify(r)); return r.errors; };
const ok = (raw) => { const r = parseAgent(raw); assert.equal(r.ok, true, JSON.stringify(r)); return r.agent; };

test("minimal valid file gets defaults", () => {
  const a = ok(mk(""));
  assert.equal(a.name, "my-agent");
  assert.equal(a.schedule, "manual");
  assert.equal(a.output, "pr");
  assert.equal(a.budgetUsd, undefined);
});

test("all keys accepted", () => {
  const a = ok(mk('description: "hi # there"\nschedule: weekly sun 23:59\nproject: p-1\nprincipal: bot\noutput: report\nbudget_usd: 2.5'));
  assert.deepEqual([a.description, a.schedule, a.project, a.principal, a.output, a.budgetUsd], ["hi # there", "weekly sun 23:59", "p-1", "bot", "report", 2.5]);
  for (const s of ["manual", "daily 00:00", "weekdays 07:30"]) assert.equal(ok(mk(`schedule: ${s}`)).schedule, s);
  assert.equal(ok(mk("budget_usd: 100")).budgetUsd, 100);
  assert.equal(ok(mk('budget_usd: "2.5"')).budgetUsd, 2.5);
});

test("invalid values rejected", () => {
  const bad = (line) => errs(mk(line)).filter((e) => e.startsWith("line 3:"));
  for (const l of [
    "schedule: daily 24:00", "schedule: daily 7:5", "schedule: hourly", "schedule: weekly mon",
    "schedule: weekly xyz 10:00", "schedule: daily  10:00",
    "project: Foo", "project: -a", `project: ${"a".repeat(65)}`,
    "principal: Foo", "principal: -a", `principal: ${"a".repeat(65)}`,
    "output: email", "budget_usd: 0", "budget_usd: -1", "budget_usd: 100.01", "budget_usd: abc", "budget_usd: 1e2",
    `description: ${"x".repeat(201)}`,
  ]) assert.equal(bad(l).length, 1, l);
  assert.match(bad("schedule: daily 24:00")[0], /schedule "daily 24:00" must be manual/);
  for (const n of ["A", "a", "a".repeat(41), "1abc"]) assert.ok(errs(`---\nname: ${n}\n---\n${BODY}`).some((e) => e.startsWith("line 2: name")), n);
  assert.deepEqual(errs(`---\n---\n${BODY}`), ["name is required"]);
});

test("unknown and duplicate keys", () => {
  assert.deepEqual(errs(mk("shedule: manual")), ['line 3: unknown key "shedule"']);
  assert.deepEqual(errs(mk("output: pr\noutput: pr")), ['line 4: duplicate key "output"']);
});

test("malformed lines report the file line", () => {
  const cases = [
    ["  schedule: manual", 'line 3: expected "key: value"'],
    ["- item", 'line 3: expected "key: value"'],
    ["nocolon", 'line 3: expected "key: value"'],
    ['description: "oops', "line 3: malformed quoted value"],
    ["description: [a, b]", "line 3: lists, maps and multi-line values are not supported"],
    ["description:", 'line 3: empty value for "description"'],
  ];
  for (const [l, e] of cases) assert.deepEqual(errs(mk(l)), [e]);
});

test("missing fences", () => {
  assert.deepEqual(errs(`name: x\n${BODY}`), ['line 1: expected front matter opening "---"']);
  assert.deepEqual(errs(`---\nname: abc\n${BODY}`), ['front matter: missing closing "---"']);
});

test("comments", () => {
  const a = ok(mk('# full line\ndescription: plain # stripped\nproject: a#b'.replace("project: a#b", "project: ab")));
  assert.equal(a.description, "plain");
  assert.equal(ok(mk("description: a#b")).description, "a#b");
  assert.equal(ok(mk('description: "x # y" # c')).description, "x # y");
});

test("body rules", () => {
  assert.ok(errs(mk("", "## Objective\n\n## Success Criteria\n- [judge] x\n")).includes("body: ## Objective is required and must not be empty"));
  assert.ok(errs(mk("", "## Objective\nx\n")).includes("body: ## Success Criteria needs at least one bullet"));
  assert.ok(errs(mk("", "## Objective\nx\n## Success Criteria\n- [judge] a\n- plain\n")).includes("body: criterion 2 has no [auto], [judge] or [human] tag"));
  assert.ok(errs(mk("", "## Objective\nx\n## Success Criteria\n- [human] a\n")).includes("body: at least one criterion must be [auto] or [judge]"));
  const nocmd = "## Objective\nx\n## Success Criteria\n- [auto] a\n";
  assert.ok(errs(mk("", nocmd)).includes("body: criterion 1 is [auto] but has no command"));
  ok(mk("", "## Objective\nx\n## Success Criteria\n- [auto] a\n  ```check\n  true\n  ```\n"));
});

test("multiple errors together", () => {
  const e = errs("---\nshedule: x\nschedule: nope\n---\n## Success Criteria\n- [judge] a\n");
  assert.ok(e.length >= 4, e.join("|"));
});

test("CRLF parses like LF; intent is body only", () => {
  const lf = mk('description: d');
  const a = ok(lf), b = ok(lf.replace(/\n/g, "\r\n"));
  assert.deepEqual({ ...b, body: 0, intent: 0 }, { ...a, body: 0, intent: 0 });
  assert.equal(b.body, a.body);
  assert.ok(!/name:|^---/m.test(a.intent.raw));
  assert.equal(a.body, a.intent.raw);
  assert.equal(a.intent.successCriteria.length, 2);
});

test("parseIntent on a front matter file is unchanged", () => {
  const raw = mk("");
  assert.equal(parseIntent(raw).raw, raw);
});
