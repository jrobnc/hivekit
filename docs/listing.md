# HiveKit Codex Plugin — Listing & Submission

Everything needed to submit the plugin to the OpenAI directory. Plugin internals and auth live in [codex-plugin.md](codex-plugin.md).

## Fields

| Field | Value | Source |
|---|---|---|
| `name` | `hivekit` | `plugin.json` |
| `displayName` | `HiveKit` (≤ 30) | `interface.displayName` |
| `shortDescription` | `Intent-driven build & review` (28 chars, ≤ 30) | `interface.shortDescription` |
| `longDescription` | see below | `interface.longDescription` |
| `category` | `Developer Tools` (confirm the exact category title in the dashboard) | `interface.category` |
| Developer | Jody Roberts (`https://github.com/jrobnc`) | `interface.developerName`, `author` |
| Website URL | https://github.com/jrobnc/hivekit | `interface.websiteURL` |
| Support URL | https://github.com/jrobnc/hivekit/issues (reviewer contact info) | submission form |
| Terms URL | https://github.com/jrobnc/hivekit/blob/main/docs/terms.md | `interface.termsOfServiceURL` |
| Privacy URL | https://github.com/jrobnc/hivekit/blob/main/docs/privacy.md | `interface.privacyPolicyURL` |

The privacy and terms URLs resolve once this branch is merged to main.

**`longDescription`:**

> Run HiveKit's Planner, Generator, and Evaluator loop from Codex. Declare what done
> means in a HIVE.md intent file, then build, review, or improve code until the success
> criteria hold. HiveKit runs locally in the repo and sends no data to its authors. Model
> calls go to Anthropic with your own key; the optional, off-by-default Jev gate
> (`HIVEKIT_JEV=1`) sends masked text to api.typesafe.ai. Requires the hivekit CLI and an
> ANTHROPIC_API_KEY.

## Optional self-check prompts

Skills-only plugins need no MCP test cases; these prompts are a self-check, not a submission requirement.

### Positive (5)

| # | Prompt | Expected behaviour |
|---|---|---|
| 1 | "Review this codebase for bugs and code quality issues" | `hivekit-review` fires; agent runs `hivekit --mode review`; read-only, reports findings. |
| 2 | "Build user authentication with JWT" | `hivekit-build` fires; agent runs `hivekit --mode build` (after confirming a HIVE.md or task). |
| 3 | "Fix the issues from the last review" | `hivekit-improve` fires; agent runs `hivekit --mode improve` against the prior report. |
| 4 | "Help me write a HIVE.md for adding a payment system" | `hivekit-intent` fires; agent drafts a HIVE.md with checkable criteria; runs no CLI. |
| 5 | "Run a deep review of the API layer" | `hivekit-review` fires; agent runs `hivekit --mode review --depth deep` scoped to the API layer. |

### Negative (3)

| # | Prompt | Expected behaviour |
|---|---|---|
| 1 | "What's the weather in San Francisco?" | No skill fires; no CLI runs. |
| 2 | "Write a haiku about programming" | No skill fires; no CLI runs. |
| 3 | "Explain how TCP/IP works" | No skill fires; no CLI runs. |

## Demo script (optional; no recording required for skills-only plugins)

| Time | Shot |
|---|---|
| 0–10s | Terminal: clone, `npm ci && npm run build`, `npm link`. |
| 10–20s | Export `ANTHROPIC_API_KEY` and `HARNESS_ALLOW_API_KEY=1`; run `codex plugin marketplace add .`, install from the Plugins Directory and restart; show the four skills. |
| 20–30s | In `examples/hello-hive`, prompt Codex: "Review this repo with HiveKit". |
| 30–45s | Run output streaming: parallel specialist review agents reporting findings. |
| 45–55s | Open the written report and its findings. |
| 55–60s | `tail -1 ~/.cache/hivekit/ledger.jsonl` to show the cost line. |

## Reviewer notes

- Use a test-scoped `ANTHROPIC_API_KEY` with spend limits, and set `HIVEKIT_MAX_USD_PER_AGENT`.
- Sample repo: `examples/hello-hive` (includes a `HIVE.md`).
- Setup: see "Use from Codex" in the [README](../README.md#use-from-codex).

## Required for submission

- A verified OpenAI developer organization
- The logo (`plugins/hivekit/assets/logo.svg`)
- The required `interface` fields in the manifest
- HTTPS website, privacy and terms URLs that are live
- The required skill scans passing (each `SKILL.md` has valid `name` and `description` YAML)
- Release notes
- The submission ZIP

## Release notes (1.0.0)

Initial release: review, build, improve and intent skills.
Runs the local hivekit CLI; requires your own ANTHROPIC_API_KEY.

## Build the submission ZIP

```sh
cd plugins/hivekit && zip -r "${TMPDIR:-/tmp}/hivekit-plugin-1.0.0.zip" . -x '*.DS_Store'
unzip -l "${TMPDIR:-/tmp}/hivekit-plugin-1.0.0.zip"   # plugin.json must be at the ZIP root
```

The ZIP must not contain hooks, `apps` or `.app.json`.

## Checklist

- [ ] Verified OpenAI developer organization
- [ ] Privacy and terms URLs live on main
- [ ] Skill scans pass
- [ ] ZIP built and inspected
- [ ] `node --test test/plugin-manifest.test.mjs` and `npm test` exit 0
