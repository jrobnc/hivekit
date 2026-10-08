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

HiveKit writes a cost ledger to `~/.cache/hivekit/ledger.jsonl`. Set `HIVEKIT_LEDGER` to use a different path. Each entry holds the model, token counts, cost, and a timestamp. The file stays on your machine.

## Contact

Open an issue at https://github.com/jrobnc/hivekit/issues.
