# HiveKit Codex Plugin — Publishing Guide

## Overview

The HiveKit Codex plugin exposes four skills (review, build, improve, intent) that let
Codex users run HiveKit's Planner → Generator → Evaluator loop from within OpenAI's
agent environment. Each skill instructs the Codex agent to run the `hivekit` CLI.

## Prerequisites

Before a Codex user can use the plugin, they need:

1. **`hivekit` CLI** — install from GitHub and put it on your PATH:
   ```sh
   git clone https://github.com/jrobnc/hivekit && cd hivekit
   npm ci && npm run build
   npm link        # optional: puts `hivekit` on PATH; otherwise run ./bin/hivekit
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
   git clone https://github.com/jrobnc/hivekit && cd hivekit
   npm ci && npm run build
   npm link        # optional: puts `hivekit` on PATH; otherwise run ./bin/hivekit
   ```

2. Run the validation test:
   ```sh
   node --test test/plugin-manifest.test.mjs
   ```

3. Run the full test suite:
   ```sh
   npm test
   ```

4. Add the marketplace from the clone root: `codex plugin marketplace add .` (or the absolute
   path to the clone), then `codex plugin marketplace list` to confirm `hivekit` is listed.
   Install with `codex plugin add hivekit@hivekit` (or from the Plugins Directory in the ChatGPT
   desktop app, then restart it), and
   verify that the four skills appear and respond to the prompts in [listing.md](listing.md).

## Plugin Manifest Format

- The root manifest is `plugins/hivekit/plugin.json` (no `.codex-plugin/` overlay). Marketplace entry: `.agents/plugins/marketplace.json`.
- Portable keys: `$schema`, `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `skills`, `extensions`.
- Listing metadata lives in `extensions["com.openai"].interface`.
- Spec: https://developers.openai.com/plugins/build/plugins and https://developers.openai.com/plugins/deploy/submission.
- The plugin is skills-only: no apps, hooks or MCP servers. An MCP server can't be added later, so that would need a new plugin.

Listing metadata, test prompts, and the submission checklist live in [listing.md](listing.md).

## OpenAI Guidelines Compliance

- **No promotional or comparative language** — Descriptions state what the tool does,
  not that it's "the best" or "better than X".
- **General audiences (13+)** — No age-restricted content.
- **Minimal data collection** — HiveKit runs locally. External calls go to the
  Anthropic API (using the user's own key). The one exception is the opt-in
  `HIVEKIT_JEV=1` gate (off by default), which sends masked evaluator text to
  `api.typesafe.ai`. No telemetry, no analytics, nothing sent to the HiveKit authors.
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
