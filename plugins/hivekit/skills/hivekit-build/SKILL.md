---
name: hivekit-build
description: Build features using HiveKit's Planner, Generator, and Evaluator loop.
---

# hivekit-build

Run a HiveKit build to implement features. HiveKit plans the work, generates code across sprints, and evaluates the result against success criteria until they pass.

## When to use

Use this skill when the user asks to build a feature, implement a task, or create something new in a codebase.

## Command

There are two ways to start a build:

### 1. Pass a task string

```sh
hivekit "<task description>" --mode build --cwd .
```

### 2. Use a HIVE.md intent file

```sh
hivekit --intent HIVE.md --mode build --cwd .
```

A `HIVE.md` file declares the objective, success criteria, and constraints for a build. See [HIVE_SPEC.md](../../../../docs/HIVE_SPEC.md) for the full format. If a `HIVE.md` or `intent.md` exists in `--cwd`, HiveKit auto-discovers it — you can omit `--intent`.

### Available flags

| Flag | Description |
|---|---|
| `--mode build` | Explicitly sets build mode (also inferred from task context). |
| `--intent <path>` | Path to a HIVE.md intent file to drive the build. |
| `--sprint <N>` | Scope the build to sprint N from the plan. |
| `--plan <path>` | Reuse an existing plan file (skips the Planner step). |
| `--depth <quick\|standard\|deep>` | Agent thoroughness. Default: `standard`. |
| `--focus <area>` | Focus area (e.g., `--focus api`). |
| `--cwd <path>` | Working directory. Defaults to the current directory. |
| `--name <name>` | Human-readable name for this run. |
| `--max-turns <N>` | Maximum agent turns. Default: 100 for build. |
| `--yaml` | Emit a structured intent.yaml alongside the markdown intent file. |

### Examples

```sh
# Build from a task string
hivekit "add user authentication with JWT" --mode build

# Build from a HIVE.md intent file
hivekit --intent HIVE.md --cwd ~/dev/my-app

# Run only sprint 2 from an existing plan
hivekit "build sprint 2" --mode build --sprint 2 --plan .hivekit/runs/prev-run/plan.md

# Deep build focused on the API layer
hivekit "build REST endpoints for users" --mode build --depth deep --focus api
```

## Artifacts

Each run creates a directory at `.hivekit/runs/<run-id>/` containing:

- **`plan.md`** — The generated build plan with sprints and tasks.
- **`progress.md`** — Sprint-by-sprint progress log.
- **`result.json`** — Structured result with `outcome` field and metadata.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | Build passed evaluator verification. | Read `result.json` for details. |
| 1 | The harness itself crashed (unhandled exception). | Read stderr for the stack trace. |
| 2 | Build failed verification. | Read the report and run `hivekit-improve` on the plan. |
| 3 | Evaluation rounds exhausted — failed to pass within the configured rounds. | Read the report; narrow the task or raise `--max-turns`. |
| 4 | An error occurred during the run. | Check credentials, flags, and network. Read stderr. |

## Reading the result

- Check `result.json` for the `outcome` field to see pass/fail status and details.

## HIVE.md overview

A `HIVE.md` declares what "done" means so the Evaluator can verify the build. Key sections:

- **Objective** — What you want built.
- **Success Criteria** — Checkable conditions tagged `[auto]`, `[judge]`, or `[human]`.
- **Constraints** — Boundaries (e.g., "no new dependencies").
- **Out of Scope** — What to explicitly skip.

See [HIVE_SPEC.md](../../../../docs/HIVE_SPEC.md) for the full specification. Use the `hivekit-intent` skill for help writing a good HIVE.md.

## Prerequisites

- Requires macOS or Linux (the launcher is a bash script).
- `ANTHROPIC_API_KEY` must be set (Codex does not have Claude Code OAuth).
- `HARNESS_ALLOW_API_KEY=1` must be set.
- The `hivekit` CLI must be installed from GitHub (`git clone https://github.com/jrobnc/hivekit && cd hivekit && npm install && npm run build && npm link`). Do not install the npm package named "hivekit": that name belongs to an unrelated third-party project.

## Safety rules

- **Never push** commits to a remote on behalf of the user.
- **Never deploy** code or run deployment scripts.
- **Review code before merge** — present the generated code to the user for review.
