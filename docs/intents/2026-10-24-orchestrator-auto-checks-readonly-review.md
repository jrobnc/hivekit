# HIVE.md — hivekit: the orchestrator runs [auto] checks itself; review mode is read-only

Stakes: high

## Objective

Two findings from an independent review of this repo (2026-10-24), both about where trust sits:

1. `[auto]` criteria are not actually deterministic. The evaluator agent is told to "RUN the actual
   check" (`src/prompts/*`, `src/intent.ts:124`) and gets Bash (`src/evaluator.ts:329`). So the realest
   tier is still an agent's claim about an exit code, made inside a context that repo content can
   inject. The orchestrator must execute `[auto]` checks itself and hand the evaluator the captured
   transcript as read-only evidence. A failed orchestrator-run check must make the round fail in code,
   whatever the evaluator writes.
2. Review mode is marketed as the safe reach for unfamiliar code, yet review agents get Bash and Write.
   Pointing it at an untrusted repo is prompt injection → code execution. In review mode every agent
   (planner, review generators, evaluator, advisor) gets Read/Glob/Grep only.

Read `README.md`, `src/intent.ts`, `src/evaluator.ts`, `src/generator.ts`, `src/planner.ts`,
`src/advisor.ts`, `src/sdk-utils.ts`, `src/outcome.ts`, the prompts under `src/prompts/`, and the test
suite (`test/*.test.mjs`, especially `intent.test.mjs`, `evaluator.test.mjs`, `outcome.test.mjs`). The
verdict contract (PASS literal first line, fail-closed on malformed scorecards) is load-bearing: extend
it, do not weaken it. TypeScript, no new runtime dependencies, `npm test`.

## Success Criteria

- [auto] **Intent syntax for executable checks.** An `[auto]` bullet may carry its command in backticks
  at the end of the bullet (`` - [auto] tests pass: `npm test` ``) or in a fenced block tagged `check`
  directly under the bullet (multi-line commands). `parseIntent` returns `{ tier: "auto", text,
  command? }`. An `[auto]` criterion WITHOUT a command is still accepted but is reported as
  `auto (unverified)` and graded by the evaluator as today, with one WARN line at parse time naming it.
  Tests cover both forms, a bullet with no command, and a fenced block that belongs to a `[judge]`
  bullet (ignored, warned).
- [auto] **Orchestrator execution.** Before each evaluator round (and in review mode before the single
  evaluation), the orchestrator runs every `[auto]` command itself: `spawn` with `shell: false` of
  `["bash", "-lc", command]`, `cwd` = the run's target cwd, env = the run's env minus `ANTHROPIC_API_KEY`,
  a per-check timeout (default 600 s, `HIVEKIT_CHECK_TIMEOUT` overrides), stdout+stderr captured and
  truncated to the last 8 KB each. The results `{ index, text, command, exitCode, timedOut, durationMs,
  stdoutTail, stderrTail }` are written to the run dir (`checks-round-N.json`) and appended to the
  ledger entry. Tests use a fake command (`exit 3`, `sleep` past a 1 s timeout, large output) and assert
  the record shape; no network.
- [auto] **Evaluator contract.** The evaluator prompt no longer says "RUN the actual check". It receives
  the orchestrator's transcript per `[auto]` criterion and must grade from it; the prompt tells it the
  transcript is the only admissible evidence for those criteria. The evaluator's `allowedTools` lose
  `Bash` and `Write` (Read/Glob/Grep stay; it reads code, it does not run it). In code, `outcome`: if
  any orchestrator-run check has `exitCode !== 0` or `timedOut`, the round is `failed` with reason
  `auto_check_failed` listing the criteria, regardless of the evaluator's text; a PASS first line with a
  failed check is recorded as `evaluator_contradicted_checks` in the ledger. Tests: PASS text + failing
  check → failed; FAIL text + passing checks → failed (unchanged); PASS + all checks pass → passed.
- [auto] **Review mode is read-only.** When `mode === "review"`, every agent's `allowedTools` is exactly
  `["Read", "Glob", "Grep"]`: planner, review generators, evaluator, advisor. `[auto]` commands in a
  review intent are still run by the orchestrator (that is the point: the loop runs them, not the agent),
  and the review report says so. `HIVEKIT_REVIEW_ALLOW_BASH=1` restores Bash for review agents and
  prints one WARN line at start naming the risk. Tests assert the tool lists per mode and the env opt-in.
- [auto] `npm test` passes; `npm run build` passes; `bin/hivekit --help` shows the new syntax in one
  line and the README "Intent" section documents the check syntax, the transcript hand-off, and the
  read-only review default. The README no longer claims a judge panel exists unless one does (today it
  does not: say "single evaluator; panel planned").
- [judge] A reader of `src/outcome.ts` can see that a failed orchestrator check cannot be talked past
  by any evaluator text.
- [human] The owner runs one real build with a failing `[auto]` command and sees `auto_check_failed`.

## Constraints

- No new runtime dependencies. Keep the verdict parser's fail-closed behaviour. Do not change generator
  tools in build/improve mode. Do not touch the ledger's existing fields (add only).
- Backward compatible: existing intents without commands keep working (with the WARN).

## Out of Scope

A multi-judge panel; changing the planner's planning behaviour; the cost model; the admission guard.
