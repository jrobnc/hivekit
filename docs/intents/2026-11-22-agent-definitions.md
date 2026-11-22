# HIVE.md — agent definition files

## Objective
Let an owner define a named, reusable agent as one file and run it with `hivekit --agent <file>`. An agent definition is a HIVE.md intent with a small front matter block, so the same file states the agent's standing job, how each run is judged, and the facts other tools need (schedule, where it runs, who it runs as). hivekit owns the format and the judging; it does not schedule or enforce permissions.

## The format (decided; implement exactly this)
A markdown file. First line `---`, then `key: value` lines, then a closing `---` line, then an ordinary HIVE.md body.

Front matter is a strict subset, parsed without a YAML dependency: one `key: value` per line, values are plain or double-quoted single-line strings, `#` starts a comment only at line start or after whitespace outside quotes, blank lines allowed, no nesting, no lists, no multi-line values. Anything else is an error naming the line number.

Keys:
- `name` (required): `^[a-z][a-z0-9-]{1,39}$`.
- `description` (optional): one line, at most 200 characters.
- `schedule` (optional): `manual` (default when absent), `daily HH:MM`, `weekdays HH:MM`, or `weekly <mon|tue|wed|thu|fri|sat|sun> HH:MM`. 24-hour clock, local time of whichever tool schedules it. hivekit validates the syntax only and never schedules anything.
- `project` (optional): `^[a-z0-9][a-z0-9-]{0,63}$`. Opaque to hivekit.
- `principal` (optional): `^[a-z0-9][a-z0-9-]{0,63}$`. Opaque to hivekit.
- `output` (optional): `pr` (default) or `report`.
- `budget_usd` (optional): a positive number, at most 100.
- Unknown keys are an error (a typo must not silently drop a schedule).

Body rules for an agent (stricter than a plain intent, because nobody is watching a recurring run):
- `## Objective` is required and non-empty.
- `## Success Criteria` has at least one bullet, every bullet carries an explicit `[auto]`, `[judge]` or `[human]` tag, and at least one bullet is `[auto]` or `[judge]`.
- Every `[auto]` bullet has a command (trailing code span or check fence).

## Behaviour
- New module `src/agent.ts` exporting `parseAgent(raw: string): { ok: true; agent: AgentDef } | { ok: false; errors: string[] }` and `loadAgent(path)`. `AgentDef` holds the validated front matter fields (with defaults applied), `intent: IntentDoc` built from the body only (front matter stripped, so it never reaches the planner as criteria text), and `body: string`. All errors are collected and returned together, each one line, not just the first.
- `hivekit --agent <file>`: validates; on errors prints each to stderr prefixed `agent:` and exits 2 without starting a run or spending anything. When valid it behaves as `--intent` does with the body, with the run name defaulting to the agent's `name`. `--agent` with `--intent`, `--plan`, `--check`, or a task string is a usage error (exit 2).
- `hivekit --agent <file> --validate`: validate only. Exit 0 and one line `agent <name>: ok (<n> criteria; schedule <schedule>)` on success; exit 2 with the error lines otherwise. With `--json` it prints one JSON object instead: `{"ok":true,"agent":{name,description,schedule,project,principal,output,budgetUsd},"criteria":[{tier,text,hasCommand}],"body":"..."}` or `{"ok":false,"errors":[...]}`. `--validate` and `--json` without `--agent` are usage errors. Validation performs no network call, spawns nothing, and writes no file.
- The run's `result.json` gains `agent: "<name>"` when the run was driven by `--agent` (absent otherwise), and the ledger line for the run carries the same field, so a caller can tell which agent a run belonged to.
- A plain `--intent` file that happens to start with a front matter block keeps working exactly as today (no new validation on that path).
- `--help` documents `--agent`, `--validate`, `--json`.
- Export `parseAgent`, `loadAgent` and the `AgentDef` type from the library entry point alongside the existing intent exports.

## Docs
- `docs/AGENT_SPEC.md`: the format above, the body rules and why, the split of responsibility (hivekit: format and judging; a scheduler files runs; a supervisor enforces repos, grants and budgets), and the honest limit that `schedule`, `project`, `principal`, `output` and `budget_usd` are declarations hivekit checks for syntax only.
- `examples/agents/dependency-watch.md`: a complete, valid example agent (fictional project names; weekdays schedule; one `[auto]` criterion with a harmless command such as `test -f reports/dependency-watch.md`, and judge criteria).
- README: a short "Agents" section linking the spec. One CHANGELOG-style note if the repo keeps one.

## Success Criteria
- [auto] the whole suite passes: `npm test`
- [auto] the example agent validates: `node dist/index.js --agent examples/agents/dependency-watch.md --validate`
- [judge] tests cover every front matter key's accept and reject cases, unknown keys, malformed lines with line numbers, each schedule form and bad times (24:00, 7:5), the three body rules, multiple errors reported together, and CRLF input
- [judge] tests prove `--agent` with an invalid file exits 2 before any run directory, ledger line or provider call is made, and that the usage conflicts exit 2
- [judge] tests prove `result.json` carries `agent` for an agent run and omits it for an intent run, using the existing test seams (no real model call)
- [judge] the `--intent` path is unchanged: existing intent tests are untouched and still pass
- [judge] front matter never reaches the planner or evaluator as criteria: the IntentDoc is built from the body only

## Constraints
- No new runtime dependency. TypeScript, same style as `src/intent.ts`.
- Tests must not make network or model calls and must not open local sockets.
- Do not change the meaning of any existing flag or the shape of existing result.json fields.
- This repository is public: no personal names, no private repo names, no machine paths in code, docs, examples or tests.

## Out of Scope
- Scheduling, timers, cron or daemons of any kind.
- Enforcing project, principal, output or budget.
- Any change to hive-control or other repositories.
- Removing this HIVE.md (the operator archives it after the run).
