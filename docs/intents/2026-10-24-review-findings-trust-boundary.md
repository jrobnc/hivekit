# REVIEW-FINDINGS.md — review fixes: the trust boundary of orchestrator-run checks

Stakes: high

## Objective

An independent review of `fix/orchestrator-auto-checks-readonly-review` found that the new
orchestrator-run `[auto]` checks moved the trust problem rather than closing it in two places, and
left several sharp edges. Fix them all here. TypeScript, no new runtime dependencies, `npm test`;
every fix gets a test that fails before and passes after; keep the verdict parser fail-closed.

## Success Criteria

- [auto] **Review mode never executes commands from the reviewed tree.** Today `resolveIntent`
  (`src/index.ts` ~215-230) auto-discovers `HIVE.md`/`intent.md` under `--cwd` in every mode and then
  runs their `[auto]` commands with `bash -lc` in that cwd, so an untrusted repo gets code execution on
  the host by writing a `HIVE.md`. Rule: an intent file that lives under `--cwd` (auto-discovered or
  passed with `--intent`) is a *trusted* source only in build/improve mode. In review mode its
  `[auto]` commands are NOT executed: they are reported as `auto (not run: intent is inside the reviewed
  tree)`, and the run prints one WARN naming the file. Commands run in review mode only when the
  intent file is outside `--cwd` (resolve both with `realpath`; symlinks inside cwd count as inside),
  or when `HIVEKIT_REVIEW_ALLOW_BASH=1` is set (the same opt-in that restores Bash). Tests: the
  review's probe (repo `HIVE.md` with a `touch` command, `--mode review --cwd repo`, no task) leaves no
  file and the result marks the criterion not run; the same intent copied outside cwd runs; the env
  opt-in runs it with the WARN. README: replace "the command is your text from HIVE.md" with the exact
  rule. `npm test` is the command for this bullet: `npm test`
- [auto] **Agents never load the reviewed repo's settings or hooks.** `src/providers/claude.ts` passes
  `settingSources: ["user"]` for every agent in review mode and leaves the SDK default elsewhere, with a comment citing the
  SDK note that omitting it loads `.claude/settings.json` + `settings.local.json` of the target
  (hooks run shell commands). `test/providers/claude-tools.test.mjs` asserts the option per mode.
  README's review-mode paragraph states it. `npm test`
- [auto] **Check env is as strict as the agent Bash tool it replaced.** `runChecks` strips
  `ANTHROPIC_API_KEY`, every `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`, and any variable whose name
  matches `/(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)$/i` unless listed in `HIVEKIT_CHECK_ENV_KEEP`
  (comma-separated); test asserts a token var is absent inside the check. `npm test`
- [auto] **The ledger holds no command output.** The `phase:"checks"` ledger line carries per-check
  `{index, exitCode, timedOut, durationMs, bytesStdout, bytesStderr}` only; transcripts stay in
  `checks-round-N.json`. `docs/privacy.md` is updated to say exactly what the ledger and the run dir
  hold. The line keeps `error: true` only for an orchestrator failure to spawn, not for a failed
  check (add `failedChecks: N`); README ledger section updated. `npm test`
- [auto] **Timeout handling.** `HIVEKIT_CHECK_TIMEOUT` is clamped to `2**31 - 1` ms (test: a huge
  value no longer times out at 1 ms); on timeout send SIGTERM to the group, wait 5 s, then SIGKILL
  (test with a trap that ignores TERM → killed after the grace; one that honours TERM → exits before
  the kill). A check that exits 0 but leaves a background process holding the pipes: settle on
  `exit` with a 2 s pipe-drain grace, record `exitCode: 0`, `timedOut: false`, and add
  `orphanedPipes: true` so the report can say "the check left a background process"; README and
  HIVE_SPEC say not to background processes in a check. `npm test`
- [auto] **Crash path reports the current round.** `lastChecks`/`checksRound` and the ledger append
  happen right after `runChecks`, before `runEvaluator`, so an evaluator error in round N reports
  round N's checks (test from the review's probe B: checks pass r1, fail r2, evaluator errors r2 →
  `autoChecks.path` is `checks-round-2.json` and the ledger has a `checks-r2` line). `npm test`
- [auto] **Review mode outcome is honest.** In review mode a failed `[auto]` check keeps exit 0 and
  `review_completed` but sets `autoChecks.failed`, the report banner says "N auto checks failed (reported,
  not enforced in review mode)", and README says so in the review-mode paragraph. `npm test`
- [auto] **No silent verification gap in task-string runs.** When a run has no intent (task string
  only) or no `[auto]` command at all, the orchestrator prints one WARN: "no [auto] commands: nothing
  is executed at verification; the evaluator grades from code and progress.md only", and the
  evaluator prompts (`evaluator-build.md`, `evaluator-improve.md`) no longer ask for proof the agent
  cannot obtain ("REQUIRE proof of xcodebuild", "Read modified files" via git): they say what evidence
  exists (the transcript, the files, progress.md) and tell the evaluator to grade conservatively when
  no check ran. New flag `--check <cmd>` (repeatable) adds orchestrator-run checks to a task-string run.
  Tests for the WARN and the flag. `npm test`
- [auto] **Parser and docs teach the working form.** A non-`check` fence directly under an `[auto]`
  bullet warns specifically ("fence tagged `sh` under criterion N ignored; tag it `check`").
  `examples/hello-hive/HIVE.md`, `plugins/hivekit/skills/hivekit-intent/SKILL.md` and README examples
  use trailing-backtick or ```check forms that actually produce a command; a parse test over the
  example intent asserts every `[auto]` has a command; README's claim about the example is true.
  Review-mode planner retry: in review mode the retry is skipped and the first result's text is used
  as the plan (or the run fails with a clear message), never a retry that demands Write. `npm test`
- [auto] **This repo's own archived intents are left as they are** (history), but `docs/intents/README.md`
  (create if missing) says new intents must give every `[auto]` a command. `npm test`
- [auto] `npm run build` and `npm test` pass; `bin/hivekit --help` lists `--check` and
  `HIVEKIT_CHECK_ENV_KEEP`. `npm test`
- [judge] A reader of README's review-mode paragraph can tell exactly what can and cannot run on their
  machine when they point hivekit at a stranger's repo.

## Constraints

No new runtime dependencies. Do not change build/improve generator tools. Add ledger fields only;
remove the transcript fields introduced by the previous commit (never shipped). Keep PASS-first-line.

## Out of scope

A judge panel; the cost model; the admission guard; default `npm test` auto-detection.
