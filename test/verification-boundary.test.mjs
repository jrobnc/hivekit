// End-to-end regression tests for the verification boundary.
//
// Reproduces the real defect from the Cowork Hub ACP S1 improve run:
//   evaluator FAILED x3 -> max rounds reached -> process exited 0 and the only
//   human-facing artifact (report.md) said "Result: PASS".
//
// These tests drive the REAL dist/index.js as a subprocess. The Agent SDK is
// replaced by test/helpers/fake-sdk.mjs through a node:module resolve hook
// (--import test/helpers/register-stub.mjs). Production code contains no test
// hook, env switch or stub path of its own — a flag that could fake the
// verification layer would itself be a fail-open.
//
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertNoSurvivingSuccessClaim } from "./helpers/claim-oracle.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "index.js");
const REGISTER = join(ROOT, "test", "helpers", "register-stub.mjs");

const PLAN = `# Improvement Spec

## Improvement 1: fix the validator
Do the thing.

## Improvement 2: fix the probe
Do the other thing.
`;

/** An agent-authored report that lies: it claims PASS on a failing run. */
const LYING_REPORT = `## Harness Improvement Report
**Run ID**: test
**Result**: PASS

### Scores
| Criterion   | Score | Notes |
|-------------|-------|-------|
| Completion  | 100   | All steps implemented |
| Safety      | 100   | No regressions |

### Summary
Everything is fine. Ship it.
`;

/** Evaluator return text for a decisive rejection. */
const FAILING_EVAL = `EVALUATION: FAIL
Round: n/3

SCORES:
- Completion: 40/100
- Restraint: 30/100

REQUIRED FIXES:
1. The validator is still wrong.
`;

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "hivekit-vb-"));
  mkdirSync(join(dir, "repo"), { recursive: true });
  const planPath = join(dir, "plan-fixture.md");
  writeFileSync(planPath, PLAN, "utf-8");
  return { dir, repo: join(dir, "repo"), planPath };
}

/**
 * Build the fake-SDK script for `rounds` generate/evaluate cycles.
 * Each round: 1 improve agent (writes progress-N.md), then the evaluator
 * (writes the lying report.md, returns `evalResult`).
 */
function scriptFor(rounds, evalResult) {
  const calls = [];
  for (let i = 0; i < rounds; i++) {
    calls.push({
      writePathPattern: "progress-\\d+\\.md",
      content: "- did some work\n",
      result: "generator done",
    });
    calls.push({
      writePathPattern: "report\\.md",
      content: LYING_REPORT,
      result: evalResult,
    });
  }
  return { calls };
}

/**
 * Review mode fans out one agent per dimension, each writing findings/<dim>.json,
 * then runs the evaluator. Without real findings files the generator aborts as
 * "majority failed" and the run crashes — which would let a review-path test
 * pass for the wrong reason.
 */
function reviewScriptFor(evalResult) {
  const findings = JSON.stringify({
    dimension: "x", agent: "a", runId: "r",
    findings: [{ severity: "high", file: "f.ts", line: 1, title: "t", detail: "d", suggestion: "s", confidence: 90 }],
  });
  return {
    calls: [
      // Only the per-dimension generator prompt carries a findings/<dim>.json
      // path; the evaluator prompt carries the findings DIRECTORY, so this
      // pattern discriminates the two regardless of how many dimensions run.
      { when: "findings/[a-z]+\\.json", writePathPattern: "findings/[a-z]+\\.json", content: findings, result: "dimension done" },
      { when: "report\\.md", writePathPattern: "report\\.md", content: LYING_REPORT, result: evalResult },
    ],
  };
}

function runCli(ws, script, extraArgs = [], opts = {}) {
  const scriptPath = join(ws.dir, "sdk-script.json");
  writeFileSync(scriptPath, JSON.stringify(script), "utf-8");
  const args = [
    "--import", REGISTER, CLI,
    ...(opts.argv ?? ["fix the bugs from the last review", "--mode", "improve"]),
    "--cwd", ws.repo,
    "--plan", ws.planPath,
    ...extraArgs,
  ];
  const env = {
    ...process.env,
    NODE_OPTIONS: "",
    HIVEKIT_TEST_SDK_SCRIPT: scriptPath,
  };
  try {
    const stdout = execFileSync("node", args, { encoding: "utf-8", timeout: 60000, env });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function runArtifacts(ws) {
  const base = join(ws.repo, ".claude", "harness");
  const runs = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  assert.equal(runs.length, 1, `expected exactly one run dir, got ${runs.join(", ")}`);
  const runDir = join(base, runs[0]);
  return {
    runDir,
    result: JSON.parse(readFileSync(join(runDir, "result.json"), "utf-8")),
    report: readFileSync(join(runDir, "report.md"), "utf-8"),
    index: readFileSync(join(base, "index.md"), "utf-8"),
  };
}

// ── The exact reported defect ───────────────────────────────────────

test("REGRESSION: FAILED x3 -> max rounds -> non-zero exit -> result FAILED", () => {
  const ws = makeWorkspace();
  const run = runCli(ws, scriptFor(3, FAILING_EVAL));

  // 2. exit status MUST be non-zero. Asserted FIRST and against the raw process
  // status, because this is the exact bit that regressed: the pre-fix build fell
  // off the end of main() after three FAILED rounds and exited 0.
  assert.notEqual(run.code, 0, "exit code must be non-zero after 3 failed rounds");
  assert.equal(run.code, 3, "max-rounds exhaustion has its own exit code");

  const art = runArtifacts(ws);

  // 1. run result MUST be FAILED
  assert.equal(art.result.result, "FAILED");
  assert.equal(art.result.ok, false);

  // 3. machine-readable result MUST say failed
  assert.equal(art.result.outcome, "max_rounds_exhausted");
  assert.equal(art.result.exitCode, 3);
  assert.equal(art.result.evaluator.status, "failed");
  assert.equal(art.result.evaluator.roundsRun, 3);
  assert.equal(art.result.evaluator.maxRounds, 3);

  // 4. human report MUST say failed
  assert.ok(
    art.report.startsWith("<!-- hivekit:verdict v1 -->"),
    "report must open with the authoritative verdict banner"
  );
  assert.match(art.report, /# HIVEKIT RESULT: FAILED/);

  // 5. no success marker may be emitted
  assert.doesNotMatch(run.stdout, /HARNESS COMPLETE/);
  assert.doesNotMatch(art.index, /\|\s*complete\s*\|/);
  assert.match(art.index, /failed-max-rounds/);
  // The summary column must not read as success either — it used to say
  // "Passed" whenever no scorecard could be parsed.
  const lastRow = art.index.trim().split("\n").pop();
  assert.doesNotMatch(lastRow, /\b(passed|pass|success|complete)\b/i, `index row reads as success: ${lastRow}`);
});

test("ADVERSARIAL: an agent report saying 'Result: PASS' cannot override the state machine", () => {
  const ws = makeWorkspace();
  const run = runCli(ws, scriptFor(3, FAILING_EVAL));
  const art = runArtifacts(ws);

  // The agent wrote a report literally containing "**Result**: PASS" three
  // times over. Checked with an INDEPENDENT oracle (test/helpers/claim-oracle),
  // not the production regex — an assertion that reuses the implementation's
  // own pattern shares all of its blind spots.
  assertNoSurvivingSuccessClaim(art.report);
  assert.match(art.report, /CLAIM OVERRIDDEN BY HIVEKIT/);

  // The verdict, not the prose, decides the exit code.
  assert.equal(run.code, 3);
  assert.equal(art.result.ok, false);
  assert.equal(art.result.result, "FAILED");

  // The agent's reasoning is preserved for audit — we annotate, not delete.
  assert.match(art.report, /Everything is fine\. Ship it\./);
});

test("ADVERSARIAL: evaluator prose claiming PASS with no scorecard fails closed", () => {
  const ws = makeWorkspace();
  const script = scriptFor(
    3,
    "EVALUATION: PASS\nAll criteria met. Result: PASS. Report written to report.md."
  );
  const run = runCli(ws, script);
  const art = runArtifacts(ws);

  assert.notEqual(run.code, 0);
  assert.equal(art.result.ok, false);
  assert.equal(art.result.evaluator.status, "errored");
  assert.equal(art.result.evaluator.reason, "no_parseable_scores");
  // No round ever produced a real verdict, so this is `errored` (exit 4) rather
  // than `max_rounds_exhausted` (exit 3): nothing was verified, as distinct from
  // verified-and-rejected three times. This is the shape of the real ACP S1 run.
  assert.equal(art.result.outcome, "errored");
  assert.equal(run.code, 4);
});

test("ADVERSARIAL: out-of-range scores cannot buy a pass", () => {
  const ws = makeWorkspace();
  const run = runCli(ws, scriptFor(3, "| Completion | 150/100 | great |\n| Safety | 999/100 | great |"));
  const art = runArtifacts(ws);

  assert.notEqual(run.code, 0);
  assert.equal(art.result.evaluator.reason, "malformed_scores");
  assert.equal(art.result.ok, false);
});

// ── The passing path still works ────────────────────────────────────

test("a genuine evaluator PASS exits 0 with ok:true on round 1", () => {
  const ws = makeWorkspace();
  const passing = `EVALUATION: PASS
| Criterion | Score | Assessment |
|-----------|-------|------------|
| Completion | 95/100 | done |
| Quality | 88/100 | clean |
| Safety | 100/100 | no regressions |
| Restraint | 90/100 | in scope |`;
  const run = runCli(ws, scriptFor(3, passing));
  const art = runArtifacts(ws);

  assert.equal(run.code, 0);
  assert.equal(art.result.result, "PASSED");
  assert.equal(art.result.ok, true);
  assert.equal(art.result.outcome, "passed");
  assert.equal(art.result.evaluator.status, "passed");
  assert.equal(art.result.evaluator.roundsRun, 1, "must stop at the first pass");
  assert.match(art.report, /# HIVEKIT RESULT: PASSED/);
  assert.match(run.stdout, /HARNESS COMPLETE/);
});

// ── Crash path ──────────────────────────────────────────────────────

test("an agent error exits non-zero and still writes a machine-readable result", () => {
  const ws = makeWorkspace();
  const script = { calls: [{ result: "boom: auth failed", isError: true }] };
  const run = runCli(ws, script);
  const art = runArtifacts(ws);

  assert.notEqual(run.code, 0);
  assert.equal(run.code, 1, "hivekit crash has its own exit code");
  assert.equal(art.result.outcome, "crashed");
  assert.equal(art.result.ok, false);
  assert.equal(art.result.result, "FAILED");
  assert.ok(art.result.error, "crash result must carry the error message");
  assert.match(art.report, /# HIVEKIT RESULT: FAILED/);
  assert.doesNotMatch(art.index, /\|\s*complete\s*\|/);
});

// ── Findings from the hostile review ────────────────────────────────

test("SECURITY: a hung SDK cannot exit 0 — the process default is failure", () => {
  // main() never settles: the fake SDK awaits a promise that never resolves and
  // holds no libuv handle, so Node's event loop drains and the process exits
  // without either .then() handler running. Node's own default exit code is 0,
  // so without a fail-closed default at module load this reports success having
  // verified nothing — the original defect, one layer out.
  const ws = makeWorkspace();
  const run = runCli(ws, { calls: [{ hang: true }] });
  assert.notEqual(run.code, 0, "a run that never completes must not exit 0");
});

test("SECURITY: an INFERRED review mode does not inherit the exit-0 carve-out", () => {
  // `mode` defaults to "review" and the review regex ("check") is tested before
  // the build/improve ones, so this task infers review mode with no --mode flag.
  // The carve-out is gated on an explicit flag precisely so this cannot exit 0.
  const ws = makeWorkspace();
  const failing = `EVALUATION: FAIL\n- Security: 20/100\n- Bugs: 10/100`;
  const run = runCli(ws, reviewScriptFor(failing), [], {
    argv: ["implement payments and check the tests"],
  });

  assert.notEqual(run.code, 0, "an inferred review must not exit 0 over an evaluator FAIL");
  const art = runArtifacts(ws);
  assert.equal(art.result.ok, false);
  assert.equal(art.result.result, "FAILED");
  assert.doesNotMatch(run.stdout, /REVIEW COMPLETE/);
  assertNoSurvivingSuccessClaim(art.report);
});

test("an EXPLICIT --mode review exits 0 over a low-scoring subject", () => {
  // The documented carve-out: in review mode the scorecard grades the code
  // under review, not hivekit's work, so a damning review is a successful run.
  const ws = makeWorkspace();
  const failing = `EVALUATION: FAIL\n- Security: 20/100\n- Bugs: 10/100`;
  const run = runCli(ws, reviewScriptFor(failing), [], {
    argv: ["review the codebase", "--mode", "review"],
  });
  const art = runArtifacts(ws);

  assert.equal(run.code, 0);
  assert.equal(art.result.outcome, "review_completed");
  assert.equal(art.result.evaluator.status, "failed", "the evaluator verdict is preserved verbatim");
  // ok:true, but it is not a verification of hivekit's own work — agent success
  // claims underneath it are still annotated.
  assertNoSurvivingSuccessClaim(art.report);
});

test("SECURITY: a truncated one-row scorecard cannot buy a pass", () => {
  // `scores.every(...)` over a single element is vacuously strong. A response
  // cut off mid-table after one good row must not clear the gate.
  const ws = makeWorkspace();
  const run = runCli(ws, scriptFor(3, "| Feature Completeness | 95/100 | looks done |\n| Code Qual"));
  const art = runArtifacts(ws);

  assert.notEqual(run.code, 0);
  assert.equal(art.result.ok, false);
  assert.equal(art.result.evaluator.reason, "missing_criteria");
  assert.doesNotMatch(run.stdout, /HARNESS COMPLETE/);
});

test("SECURITY: a scorecard quoted from a prior run in a code fence cannot buy a pass", () => {
  // The evaluator has Read/Grep on the target repo, where prior report.md files
  // hold filled passing scorecards. An evaluator that declines to verify and
  // quotes one must not have that quotation read as its own verdict.
  const ws = makeWorkspace();
  const quoting = [
    "I was unable to run the tests. For reference the previous run scored:",
    "```markdown",
    "| Completion | 95/100 | ... |",
    "| Quality | 90/100 | ... |",
    "| Safety | 92/100 | ... |",
    "| Restraint | 88/100 | ... |",
    "```",
    "I cannot verify this build.",
  ].join("\n");
  const run = runCli(ws, scriptFor(3, quoting));
  const art = runArtifacts(ws);

  assert.notEqual(run.code, 0, "a quoted scorecard must not be read as a verdict");
  assert.equal(art.result.ok, false);
  assert.equal(art.result.evaluator.status, "errored");
});

test("EPIPE on stdout still produces result.json and report.md, and keeps its exit code", () => {
  // A run piped to `head` used to die on an unhandled EPIPE mid-write, before
  // any artifact was written: invariants 3 and 4 both lost.
  const ws = makeWorkspace();
  const scriptPath = join(ws.dir, "sdk-script.json");
  writeFileSync(scriptPath, JSON.stringify(scriptFor(3, FAILING_EVAL)), "utf-8");
  // `set -o pipefail` so the pipeline reports node's status, not head's —
  // otherwise this test stays green even if the exit code regresses to 0.
  const cmd = `set -o pipefail; node --import ${JSON.stringify(REGISTER)} ${JSON.stringify(CLI)} "fix the bugs" --mode improve --cwd ${JSON.stringify(ws.repo)} --plan ${JSON.stringify(ws.planPath)} | head -1`;
  let code = 0;
  try {
    execFileSync("bash", ["-c", cmd], {
      encoding: "utf-8", timeout: 60000,
      env: { ...process.env, NODE_OPTIONS: "", HIVEKIT_TEST_SDK_SCRIPT: scriptPath },
    });
  } catch (err) {
    code = err.status;
  }
  assert.equal(code, 3, "the verdict's exit code must survive a broken pipe");

  const art = runArtifacts(ws);
  assert.equal(art.result.ok, false);
  assert.equal(art.result.result, "FAILED");
  assert.match(art.report, /# HIVEKIT RESULT: FAILED/);
});

test("a read-only index.md does not downgrade a verified PASS to a crash", () => {
  // index.md is a convenience ledger, not a verdict. Guarding only the terminal
  // updateIndex left four bare calls in the phase transitions, so a read-only
  // index aborted the run at Phase 1 — turning a real PASS into `crashed`.
  const ws = makeWorkspace();
  mkdirSync(join(ws.repo, ".claude", "harness"), { recursive: true });
  const indexPath = join(ws.repo, ".claude", "harness", "index.md");
  writeFileSync(indexPath, "| Run ID | Mode | Status | Timestamp | Summary |\n|---|---|---|---|---|\n", "utf-8");
  chmodSync(indexPath, 0o444);

  const passing = `EVALUATION: PASS
- Completion: 95/100
- Quality: 88/100
- Safety: 100/100
- Restraint: 90/100`;
  const run = runCli(ws, scriptFor(3, passing));
  chmodSync(indexPath, 0o644);

  assert.equal(run.code, 0, "a cosmetic index append failure must not fail the run");
  const base = join(ws.repo, ".claude", "harness");
  const runDir = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory())[0].name;
  const result = JSON.parse(readFileSync(join(base, runDir, "result.json"), "utf-8"));
  assert.equal(result.outcome, "passed");
  assert.equal(result.ok, true);
});

test("run ids are unique within the same second", () => {
  // Second-granular ids meant two same-mode/same-name runs launched together
  // shared a run directory — and with it report.md and result.json, so one
  // caller could read a verdict belonging to the other run.
  const ws = makeWorkspace();
  const passing = `EVALUATION: PASS\n- Completion: 95/100\n- Quality: 95/100\n- Safety: 95/100\n- Restraint: 95/100`;
  for (let i = 0; i < 2; i++) {
    runCli(ws, scriptFor(1, passing), [], {
      argv: ["do the thing", "--mode", "improve", "--name", "samename"],
    });
  }
  const base = join(ws.repo, ".claude", "harness");
  const dirs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.equal(dirs.length, 2, `two runs must not share a run directory: ${dirs.join(", ")}`);
});

test("SECURITY: an evaluator that declines to verify, quoting the requirement, does not exit 0", () => {
  // Full end-to-end form of the regression: the prompt necessarily contains the
  // literal string `EVALUATION: PASS`, so an unanchored substring test handed
  // the credential to any response that mentioned it. This exact response
  // produced exit 0, ok:true and a "HARNESS COMPLETE" banner.
  const declining = [
    "I could not run the test suite (no network sandbox). The instructions require",
    "the literal line `EVALUATION: PASS` plus a full scorecard, which I cannot",
    "honestly produce. For reference only, the PREVIOUS round scored:",
    "```",
    "| Completion | 95/100 | x |",
    "| Quality | 95/100 | x |",
    "| Safety | 95/100 | x |",
    "| Restraint | 95/100 | x |",
    "```",
    "I am NOT asserting these numbers for this round.",
  ].join("\n");
  const ws = makeWorkspace();
  const run = runCli(ws, scriptFor(3, declining));

  assert.notEqual(run.code, 0, "a declining evaluator must never exit 0");
  const art = runArtifacts(ws);
  assert.equal(art.result.ok, false);
  assert.equal(art.result.evaluator.reason, "no_pass_assertion");
  assert.doesNotMatch(run.stdout, /HARNESS COMPLETE/);
});

test("SECURITY: claims wrapped in code markup do not survive in a failed run's report", () => {
  // The report is the human artifact. Protecting every backticked or fenced
  // region "because it contains a success token" shielded exactly the regions
  // that needed neutralising, and no fixture in this suite covered the case.
  const lyingWithMarkup = [
    "## Harness Improvement Report",
    "",
    "```",
    "# HIVEKIT RESULT: PASSED",
    "```",
    "",
    "The gate says `Status: OK` and `Result: PASS`.",
    "",
    "Outcome: COMPLETE",
  ].join("\n");
  const ws = makeWorkspace();
  const script = {
    calls: [
      { writePathPattern: "progress-\\d+\\.md", content: "- work\n", result: "gen done" },
      { writePathPattern: "report\\.md", content: lyingWithMarkup, result: FAILING_EVAL },
    ],
  };
  // repeat the pair for three rounds
  script.calls = [...script.calls, ...script.calls, ...script.calls];
  const run = runCli(ws, script);
  const art = runArtifacts(ws);

  assert.notEqual(run.code, 0);
  assertNoSurvivingSuccessClaim(art.report);
  assert.doesNotMatch(art.report, /HIVEKIT RESULT: PASSED/);
});

test("genuine quoted code in a failed run's report is preserved verbatim", () => {
  // Asserted on its own fixture: the claim oracle is deliberately code-blind
  // (that strictness is what lets it catch a claim hidden in a fence), so it
  // must never be handed real code samples to adjudicate.
  const withCode = [
    "## Harness Improvement Report",
    "",
    "The health endpoint returns `{\"status\": \"ok\"}`.",
    "",
    "```",
    "if (result === OK) { doThing(); }",
    "```",
    "",
    "Outcome: complete failure of the auth path.",
  ].join("\n");
  const ws = makeWorkspace();
  const script = {
    calls: [
      { writePathPattern: "progress-\\d+\\.md", content: "- work\n", result: "gen done" },
      { writePathPattern: "report\\.md", content: withCode, result: FAILING_EVAL },
    ],
  };
  script.calls = [...script.calls, ...script.calls, ...script.calls];
  const run = runCli(ws, script);
  const art = runArtifacts(ws);

  assert.notEqual(run.code, 0);
  assert.match(art.report, /if \(result === OK\) \{ doThing\(\); \}/);
  assert.match(art.report, /\{"status": "ok"\}/);
  // The finding keeps its meaning: annotating this as a suppressed success
  // claim would invert it.
  assert.match(art.report, /Outcome: complete failure of the auth path/);
});
