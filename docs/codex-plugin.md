# HiveKit Codex Plugin — Publishing Guide

## Overview

The HiveKit Codex plugin exposes four skills (review, build, improve, intent) that let
Codex users run HiveKit's Planner → Generator → Evaluator loop from within OpenAI's
agent environment. Each skill instructs the Codex agent to run the `hivekit` CLI.

## Prerequisites

Before a Codex user can use the plugin, they need:

1. **`hivekit` CLI** — install from GitHub and put it on your PATH:
   ```sh
   git clone https://github.com/jrobnc/hivekit && cd hivekit && npm install && npm run build && npm link
   ```
   Do not install the npm package named "hivekit": that name belongs to an unrelated third-party project.

2. **`ANTHROPIC_API_KEY`** — HiveKit calls Anthropic's API. Codex does **not** have
   `CLAUDE_CODE_OAUTH_TOKEN` (that only exists inside Claude Code). Users must set
   their own API key:
   ```sh
   export ANTHROPIC_API_KEY="sk-ant-..."
   ```

3. **`HARNESS_ALLOW_API_KEY=1`** — The HiveKit harness strips `ANTHROPIC_API_KEY` by
   default (it expects OAuth when run inside Claude Code). In Codex, set this to allow
   direct API key usage:
   ```sh
   export HARNESS_ALLOW_API_KEY=1
   ```

## Local Testing

1. Clone the repo and install:
   ```sh
   git clone https://github.com/jrobnc/hivekit.git
   cd hivekit && npm install && npm run build
   ```

2. Run the validation test:
   ```sh
   node --test test/plugin-manifest.test.mjs
   ```

3. Run the full test suite:
   ```sh
   npm test
   ```

4. Manual test in Codex: point your Codex environment at the `plugins/hivekit/` directory
   and verify that the four skills appear and respond to test prompts.

## Metadata Drafts

These values are ready for the OpenAI plugin submission form:

| Field | Value | Limit |
|---|---|---|
| `name` | `hivekit` | ≤ 64 chars (7) |
| `displayName` | `HiveKit` | ≤ 30 chars (7) |
| `shortDescription` | `Intent-driven build & review` | ≤ 30 chars (29) |
| `category` | `developer-tools` | — |

**`longDescription`** (for the listing page):

> Run HiveKit's Planner, Generator, and Evaluator loop from Codex. Declare what done
> means in a HIVE.md intent file, then build, review, or improve code until the success
> criteria hold. HiveKit runs locally in the repo — no data leaves your machine except
> Anthropic API calls. Requires the hivekit CLI and an ANTHROPIC_API_KEY.

## Test Prompts

### Positive (should trigger a skill)

1. "Review this codebase for bugs and code quality issues"
2. "Build user authentication with JWT"
3. "Fix the issues from the last review"
4. "Help me write a HIVE.md for adding a payment system"
5. "Run a deep review of the API layer"

### Negative (should NOT trigger a skill)

1. "What's the weather in San Francisco?"
2. "Write a haiku about programming"
3. "Explain how TCP/IP works"

## Submission Checklist

- [ ] **Website URL** — Public URL for HiveKit (e.g., GitHub repo or docs site)
- [ ] **Support URL** — Where users can get help (e.g., GitHub Issues)
- [ ] **Privacy policy URL** — Required by OpenAI
- [ ] **Terms of service URL** — Required by OpenAI
- [ ] **Verified developer** — Complete OpenAI's developer verification
- [ ] **Demo video** — Short video showing the plugin in action in Codex
- [ ] **Reviewer test account** — Provide OpenAI reviewers with:
  - A valid `ANTHROPIC_API_KEY` (test-scoped, with spending limits)
  - A sample repository with a `HIVE.md` file for testing builds
  - Clear setup instructions (install hivekit, set env vars, run a test prompt)
  - No MFA on the test account
- [ ] **Plugin validation passes** — `node --test test/plugin-manifest.test.mjs` exits 0
- [ ] **Full test suite passes** — `npm test` exits 0

## OpenAI Guidelines Compliance

- **No promotional or comparative language** — Descriptions state what the tool does,
  not that it's "the best" or "better than X".
- **General audiences (13+)** — No age-restricted content.
- **Minimal data collection** — HiveKit runs locally. The only external calls are to the
  Anthropic API (using the user's own key). No telemetry, no analytics, no data stored
  on third-party servers.
- **No authentication server** — Skills instruct the agent to run local CLI commands.
  No OAuth flow, no API keys managed by the plugin itself.
- **Accurate skill descriptions** — Each SKILL.md describes exactly what the command does,
  its limitations, and its requirements.

## Auth Model

HiveKit's auth model differs between Claude Code and Codex:

| Environment | Auth mechanism | How it works |
|---|---|---|
| **Claude Code** | `CLAUDE_CODE_OAUTH_TOKEN` | Injected by Claude Code. HiveKit strips `ANTHROPIC_API_KEY` and uses OAuth. |
| **Codex** | `ANTHROPIC_API_KEY` | User sets their own key. `HARNESS_ALLOW_API_KEY=1` must also be set to prevent the harness from stripping the key. |

Codex users need both environment variables:
```sh
export ANTHROPIC_API_KEY="sk-ant-..."
export HARNESS_ALLOW_API_KEY=1
```
