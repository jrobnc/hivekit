---
name: hivekit-review
description: Run an automated multi-dimension code review using HiveKit.
---

# hivekit-review

Run a HiveKit code review on the current repository. HiveKit's Evaluator agent inspects the codebase across multiple dimensions (correctness, structure, test coverage, etc.) and writes a report.

## When to use

Use this skill when the user asks to review code, audit quality, check for bugs, or get a second opinion on a codebase.

## Command

```sh
hivekit "<review task>" --mode review --cwd .
```

### Available flags

| Flag | Description |
|---|---|
| `--mode review` | Sets review mode. Must be passed explicitly — omitting it and relying on keyword inference changes exit-code semantics (codes 2 and 3 become reachable). |
| `--depth <quick\|standard\|deep>` | Controls thoroughness. `quick` for a fast pass, `deep` for exhaustive analysis. Default: `standard`. |
| `--focus <area>` | Narrow the review to a subsystem (e.g., `--focus auth`, `--focus ios`). |
| `--cwd <path>` | Working directory. Defaults to the current directory. |
| `--name <name>` | Human-readable name for this run. |
| `--max-turns <N>` | Maximum agent turns. Default: 40 for review. |

### Examples

```sh
# Standard review of the whole repo
hivekit "review the codebase" --mode review

# Deep review focused on authentication
hivekit "review authentication" --mode review --depth deep --focus auth

# Quick review of a specific directory
hivekit "review the API layer" --mode review --depth quick --cwd ./src/api
```

## Artifacts

Each run creates a directory at `.hivekit/runs/<run-id>/` containing:

- **`report.md`** — The full review report with findings, severity ratings, and recommendations.
- **`result.json`** — Structured result with `outcome` field and metadata.
- **`plan.md`** — The review plan (can be fed into `hivekit-improve` to fix findings).

## Exit codes (with explicit `--mode review`)

| Code | Meaning | What to do |
|---|---|---|
| 0 | Review completed (not that there are zero findings). | Read the report; pass `plan.md` to `hivekit-improve` to fix findings. |
| 1 | The harness itself crashed (unhandled exception). | Read stderr for the stack trace. |
| 4 | An error occurred during the run. | Check credentials, flags, and network. Read stderr. |

> **Note:** A review always stops after one evaluation round, so exit code 3 (rounds exhausted) never occurs in review. Exit code 2 (failed verification) is reachable only when the mode is *inferred* from keywords rather than set with `--mode review`. Always pass `--mode review` explicitly to get the contract above.

## Reading the result

- Check `result.json` for the `outcome` field.
- The `plan.md` from this run can be passed to a subsequent improve run: `hivekit --mode improve --plan .hivekit/runs/<run-id>/plan.md`.

## Prerequisites

- Requires macOS or Linux (the launcher is a bash script).
- `ANTHROPIC_API_KEY` must be set (Codex does not have Claude Code OAuth).
- `HARNESS_ALLOW_API_KEY=1` must be set.
- The `hivekit` CLI must be installed from GitHub (`git clone https://github.com/jrobnc/hivekit && cd hivekit && npm install && npm run build && npm link`). Do not install the npm package named "hivekit": that name belongs to an unrelated third-party project.

## Safety rules

- **Never push** commits to a remote on behalf of the user.
- **Never deploy** code or run deployment scripts.
- **Review before merge** — present findings to the user and let them decide what to act on.
