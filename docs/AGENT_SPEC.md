# Agent definitions

An agent definition is one file that declares a reusable, recurring run: a `HIVE.md` body (see
[HIVE_SPEC.md](HIVE_SPEC.md)) preceded by a strict front matter block. Example:
[`examples/agents/dependency-watch.md`](../examples/agents/dependency-watch.md).

```
---
name: dependency-watch
schedule: weekdays 07:30
output: report
---
## Objective
...
## Success Criteria
- [auto] report written: `test -f reports/dependency-watch.md`
- [judge] ...
```

## Who owns what

- **hivekit** owns the format and the judging: it validates the file, runs the body like `--intent`, and
  grades against the pinned criteria.
- **A scheduler** decides when to start a run and files it.
- **A supervisor** enforces which repos an agent may touch, its grants and its budget.

**The honest limit:** `schedule`, `project`, `principal`, `output` and `budget_usd` are declarations.
hivekit checks their syntax and never acts on them. In particular `budget_usd` is not wired to
`HIVEKIT_MAX_USD_PER_AGENT`.

## Front matter

The first line is exactly `---`; the block ends at the next line that is exactly `---`. Each line is
`key: value`, a `#` comment, or blank. No nesting, lists, maps or multi-line values. A value may be
double-quoted (escapes `\"` and `\\` only); otherwise ` #` starts a trailing comment. `#` inside quotes, or
with no space before it (`a#b`), is literal. Unknown and duplicate keys are errors.

| Key | Rule | Default |
|---|---|---|
| `name` | required; 2-40 chars of `a-z0-9-`, starting with a letter | none |
| `description` | at most 200 characters | absent |
| `schedule` | `manual`, `daily HH:MM`, `weekdays HH:MM` or `weekly <mon..sun> HH:MM`; single spaces; `HH:MM` is 00:00-23:59 | `manual` |
| `project` | `a-z0-9-`, up to 64 chars, not starting with `-` | absent |
| `principal` | same as `project` | absent |
| `output` | `pr` or `report` | `pr` |
| `budget_usd` | number > 0 and <= 100 | absent |

## Body rules

Checked even when the front matter has errors, so all problems are reported together.

1. `## Objective` is non-empty.
2. `## Success Criteria` has at least one bullet.
3. Every bullet is tagged `[auto]`, `[judge]` or `[human]`.
4. At least one criterion is `[auto]` or `[judge]`.
5. Every `[auto]` criterion has a command.

**Why so strict:** nobody watches a recurring run. In an interactive run an untagged bullet quietly becomes
`human` and an `[auto]` without a command is graded "unverified"; in an unattended run that means a criterion
that never actually gates anything. The planner and evaluator see only the body; the front matter never
reaches a prompt.

## CLI

```
hivekit --agent <file>                 run it (same as --intent on the body; run name defaults to the agent name)
hivekit --agent <file> --validate      check only: no provider call, run dir or ledger write
hivekit --agent <file> --validate --json
```

| Situation | Result |
|---|---|
| `--validate`, valid | stdout `agent <name>: ok (<n> criteria; schedule <schedule>)`, exit 0 |
| invalid file | one `agent: <error>` line per error on stderr, exit 2, before anything else happens |
| `--agent` with `--intent`, `--plan`, `--check` or a task | exit 2 |
| `--validate` or `--json` without `--agent` | exit 2 |

`--validate --json` prints one object to stdout (exit 0 valid, 2 invalid). Absent optional fields are `null`:

```json
{"ok":true,"agent":{"name":"…","description":null,"schedule":"manual","project":null,"principal":null,"output":"pr","budgetUsd":null},
 "criteria":[{"tier":"auto","text":"…","hasCommand":true}],"body":"…"}
{"ok":false,"errors":["line 2: unknown key \"shedule\""]}
```

## Attribution

An `--agent` run writes `"agent": "<name>"` into `result.json` and onto every ledger line it appends
(including `checks-r*` lines). Other runs have no `agent` key.

## Library

```js
import { parseAgent, loadAgent } from "hivekit/intent";
```
