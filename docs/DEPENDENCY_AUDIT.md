# Dependency audit — 2026-09-06

Lockfile-maintenance record for `jrobnc/hivekit#4`. Scope: refresh stale
`package-lock.json` metadata and resolve the transitive advisories that
downstream installs were reporting. No source, architecture, or public export
changes.

## Result

`npm audit` → **0 vulnerabilities** (was: 8 — 3 high, 3 moderate, 2 low).
Nothing was fixed with `npm audit fix` / `--force`; every change is an
explicit in-range update reviewed against the advisory's fixed version.
**No unresolved advisory remains, so there is no accepted residual risk.**

## What was stale

The lockfile root block still described the package under its pre-rename
identity (`"name": "harness"`, a single `harness` → `dist/index.js` bin) while
`package.json` had long since become `hivekit` with the `hivekit` + `harness`
bash launchers. Reinstalling against the current manifest re-synced it; the
root block now matches `package.json` exactly.

## How HiveKit actually reaches these packages

Every advisory below sat under one of two roots:

```
hivekit
├─ @anthropic-ai/claude-agent-sdk  (runtime)
│    └─ @modelcontextprotocol/sdk
│         ├─ express, express-rate-limit → ip-address, body-parser → qs
│         ├─ hono, @hono/node-server
│         └─ ajv → fast-uri
└─ tsx  (devDependency)
     └─ esbuild
```

HiveKit's only use of the Agent SDK is `import { query } from
"@anthropic-ai/claude-agent-sdk"` in `src/sdk-utils.ts`. It configures no
`mcpServers` and no MCP transport (`grep -rn "mcp\|transport" src/` is empty).
Inside `@modelcontextprotocol/sdk`, `express`, `express-rate-limit`, `hono` and
`@hono/node-server` are imported only from `server/streamableHttp.js`,
`server/express.js`, the `server/auth/*` handlers, and `examples/` — the
HTTP-server side of MCP, which HiveKit never starts. `esbuild` is
build-time-only, via `tsx`.

## HIGH advisories — package, reachability, fix

| Package | Was | Advisories | Runtime-reachable in HiveKit? | Now |
|---|---|---|---|---|
| `hono` | 4.12.9 | 27 advisories ≤ 4.12.33 (cookie injection, `serveStatic` traversal, CORS/JWT/bodyLimit bypasses, JSX SSR cross-request leaks) | **No.** All are server-side request/response handling; reached only through an MCP HTTP server transport HiveKit never instantiates. | 4.13.7 |
| `ip-address` | 10.1.0 | GHSA-v2v4-37r5-5v8g (XSS in `Address6` HTML methods), GHSA-mwp4-54f8-5fhr (leading-zero octet → SSRF / trust-boundary bypass) | **No.** Pulled in by `express-rate-limit` for client-IP keying inside the MCP HTTP server. No HTTP server, no request IPs. | 10.7.0 |
| `fast-uri` | 3.1.0 | 7 advisories ≤ 3.1.5 (host confusion via backslash / percent-encoded authority, dot-segment traversal, IPv6 SSRF, IDN canonicalization) | **Not in practice.** `ajv` is the one chain with an in-process load path — `client/index.js` and `server/index.js` both import the Ajv validator for tool JSON Schemas. But triggering it needs an attacker-controlled `$id`/`$ref` URI from a configured MCP server, and HiveKit configures none. Treated as the highest-priority fix of the three regardless. | 3.1.7 |

## Moderate / low advisories

Same MCP-HTTP-server (unreachable) or build-time (`esbuild`) posture; upgraded
in the same pass rather than left behind.

| Package | Was → Now | Note |
|---|---|---|
| `@hono/node-server` | 1.19.12 → 1.19.17 | `serveStatic` middleware bypass / Windows `%5C` traversal |
| `qs` | 6.15.0 → 6.16.0 | `stringify` DoS, array-limit bypass, `isBuffer` DoS |
| `body-parser` | 2.2.2 → 2.3.0 | DoS when an invalid `limit` silently disables size enforcement |
| `esbuild` | 0.27.5 → 0.28.2 | Arbitrary file read via the esbuild dev server on Windows; **devDependency**, and HiveKit never runs that server. Required `tsx` 4.21.0 → 4.23.13, whose pin moves from `~0.27.0` to `~0.28.0`. |

## Upgrade method

```
npm update fast-uri hono @hono/node-server ip-address express-rate-limit \
           qs body-parser esbuild tsx
```

`npm update` only moves within the semver ranges already declared by
`package.json` and by each parent, so no major-version churn happened and
**`package.json` was not modified**. Two chains needed a parent to move first:

- `express-rate-limit@8.3.2` pinned `ip-address` to an exact `10.1.0`. The MCP
  SDK asks for `express-rate-limit@^8.2.1`, so 8.7.0 (`ip-address: ^10.2.0`) is
  in range and carries the fix without an `overrides` entry.
- `tsx@4.21.0` pinned `esbuild` to `~0.27.0`, which cannot reach the patched
  0.28.1+. `package.json` already allows `tsx@^4.19.0`, so 4.23.13 is in range.

`@anthropic-ai/claude-agent-sdk` was deliberately left at 0.2.90: no advisory
required moving it, and `^0.2.90` cannot reach the current 0.3.x line without a
major-ish bump this task explicitly excludes.

## Verification

- `npm test` — 47/47 pass (same count as before the upgrade; no test was
  relaxed or skipped).
- `npm audit` — 0 vulnerabilities, in this repo and in a clean consumer tree.
- **Clean-consumer install.** `npm pack` → installed the tarball into an empty
  project → `import { extractSuccessCriteria, extractSection, loadIntent } from
  'hivekit/intent'` and `import * as types from 'hivekit/types'` resolve and
  behave; the packaged `bin/hivekit` launcher runs `--help` successfully.
  `npm audit` and `npm audit --omit=dev` on that tree both report 0.

### Known, pre-existing, out of scope

In a consumer install the `node_modules/.bin/hivekit` symlink fails
(`Cannot find module .../node_modules/dist/index.js`): the launcher derives
`ENTRY` from `dirname "$0"` without resolving the symlink, so it looks for
`dist/` next to `.bin/`. Running the same launcher at its real path
(`node_modules/hivekit/bin/hivekit`) works. This is independent of dependency
versions — it reproduces identically before this change — and fixing it is a
launcher change outside this task's scope.
