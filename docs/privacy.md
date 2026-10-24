# HiveKit Privacy Policy

## Where it runs

HiveKit runs locally on your machine. There is no hosted server, and no data is sent to the HiveKit authors.

## Telemetry

HiveKit has no telemetry and no analytics.

## Model calls

HiveKit sends prompts and repository context to Anthropic using your own API key. Those calls are governed by Anthropic's terms and privacy policy.

## Optional Jev gate

The `HIVEKIT_JEV=1` gate is off by default. When you enable it (and provide a key), HiveKit sends masked evaluator text to `api.typesafe.ai`. Emails and phone numbers are replaced before sending, and the text is capped at 1,900 characters per failure and 4,000 characters in total.

## Local cost ledger

HiveKit writes a cost ledger to `~/.cache/hivekit/ledger.jsonl`. Set `HIVEKIT_LEDGER` to use a different path. Each agent call adds one entry: `ts, label, model, provider, effort, usd, ms, cwd, maxTurns, error, runId, phase, turns`, token `usage` counts and `lane`. Each evaluation round that ran `[auto]` checks adds a line with, per check, only `{index, exitCode, timedOut, durationMs, bytesStdout, bytesStderr}`, plus `failedChecks`, and a separate line if the evaluator contradicted a failed check. The `cwd` path is recorded. The ledger holds no prompts, no commands and no command output. The file stays on your machine.

## Run directory

`.hivekit/runs/<id>/` inside the working directory holds `plan.md`, progress and findings files, `report.md`, `result.json`, advisor notes, an optional `intent.yaml`, and `checks-round-N.json`. The last one has each `[auto]` command's text and the last 8 KiB of its stdout and stderr, which can include anything your command prints. Delete the directory to remove it.

## Contact

Open an issue at https://github.com/jrobnc/hivekit/issues.
