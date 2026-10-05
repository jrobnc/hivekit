---
name: hivekit-improve
description: Fix findings from a prior HiveKit review or build.
---

# hivekit-improve

Run HiveKit in improve mode to fix issues found during a prior review or build. This feeds a previous run's plan back into the Generator and Evaluator loop to resolve findings.

## When to use

Use this skill when the user wants to fix bugs or issues identified in a prior HiveKit review, or to iterate on a build that didn't fully pass.

## Command

```sh
hivekit "fix the review findings" --mode improve --plan .hivekit/runs/<prior-run-id>/plan.md --cwd .
```

### Available flags

| Flag | Description |
|---|---|
| `--mode improve` | Sets improve mode. Required for this skill. |
| `--plan <path>` | Path to a prior run's plan.md. This tells the Generator what to fix. |
| `--depth <quick\|standard\|deep>` | Agent thoroughness. Default: `standard`. |
| `--focus <area>` | Narrow the improvement to a subsystem (e.g., `--focus auth`). |
| `--cwd <path>` | Working directory. Defaults to the current directory. |
| `--name <name>` | Human-readable name for this run. |
| `--max-turns <N>` | Maximum agent turns. Default: 60 for improve. |

### Examples

```sh
# Fix all findings from a prior review
hivekit "fix the review findings" --mode improve --plan .hivekit/runs/review-abc123/plan.md

# Fix only auth-related findings
hivekit "fix auth issues" --mode improve --plan .hivekit/runs/review-abc123/plan.md --focus auth

# Deep improvement pass
hivekit "fix all critical bugs" --mode improve --depth deep --plan .hivekit/runs/review-abc123/plan.md
```

## Artifacts

Each run creates a directory at `.hivekit/runs/<run-id>/` containing:

- **`progress.md`** — What was fixed and what remains.
- **`result.json`** — Structured result with `outcome` field and metadata.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | All improvements passed verification. |
| 2 | Some improvements failed verification. |
| 3 | Agent exhausted its turn budget without completing. |
| 4 | An error occurred during the run. |

## Typical workflow

1. Run a review: `hivekit "review the codebase" --mode review`
2. Read the report at `.hivekit/runs/<review-id>/report.md`
3. Run improve with the review's plan: `hivekit --mode improve --plan .hivekit/runs/<review-id>/plan.md`
4. Check the result and iterate if needed.

## Prerequisites

- `ANTHROPIC_API_KEY` must be set (Codex does not have Claude Code OAuth).
- `HARNESS_ALLOW_API_KEY=1` must be set.
- The `hivekit` CLI must be installed from GitHub (`git clone https://github.com/jrobnc/hivekit && cd hivekit && npm install && npm run build && npm link`). Do not install the npm package named "hivekit": that name belongs to an unrelated third-party project.

## Safety rules

- **Never push** commits to a remote on behalf of the user.
- **Never deploy** code or run deployment scripts.
- **Review code before merge** — present the changes to the user for review.
