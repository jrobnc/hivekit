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
| `--mode review` | Explicitly sets review mode (also inferred if the task contains "review"). |
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

## Reading the result

- **Exit code 0** means the review completed successfully (not that there are zero findings).
- Non-zero exit codes: 1 = crash, 2 = failed verification, 3 = evaluation rounds exhausted, 4 = error.
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
