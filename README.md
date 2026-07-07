<div align="center">
<pre>
██╗  ██╗ ██╗ ██╗   ██╗ ███████╗ ██╗  ██╗ ██╗ ████████╗
██║  ██║ ██║ ██║   ██║ ██╔════╝ ██║ ██╔╝ ██║ ╚══██╔══╝
███████║ ██║ ██║   ██║ █████╗   █████╔╝  ██║    ██║   
██╔══██║ ██║ ╚██╗ ██╔╝ ██╔══╝   ██╔═██╗  ██║    ██║   
██║  ██║ ██║  ╚████╔╝  ███████╗ ██║  ██╗ ██║    ██║   
╚═╝  ╚═╝ ╚═╝   ╚═══╝   ╚══════╝ ╚═╝  ╚═╝ ╚═╝    ╚═╝   
</pre>

**Declare what done means — hivekit builds until it's true.**

*Terraform for software* — intent-as-source for AI agents, the reference compiler for `HIVE.md`

write intent · verify by tiers · reconcile to green · Planner → Generator → Evaluator · Claude Max OAuth · Apache-2.0

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](LICENSE)
&nbsp;![Tests](https://img.shields.io/badge/tests-20%20passing-brightgreen)
&nbsp;![Built on](https://img.shields.io/badge/built%20on-Claude%20Agent%20SDK-d97757)
&nbsp;![Status](https://img.shields.io/badge/status-alpha-orange)

[Spec](docs/HIVE_SPEC.md) · [Quickstart](#get-started-60-seconds) · [Example](examples/hello-hive) · [Modes](#modes) · [License](LICENSE)

</div>

---

## What it is

`hivekit` turns a **`HIVE.md`** — a small markdown file describing *what you want* and *how "done" is verified* — into finished, verified work. You write the intent; hivekit plans it, builds it, and reconciles the result against your criteria until they hold. Models and agents are disposable; **the intent file is the durable asset.**

It's a **deterministic** multi-agent orchestrator built on the [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents/agent-sdk): the control loop is plain TypeScript, agents run inside bounded phases, and the LLM is never the control plane.

## How it works (30 seconds)

```
HIVE.md  ──►  Planner  ──►  plan.md  ──►  Generator  ──►  Evaluator  ──►  pass ─► done
(you write     compiles    (generated)    builds code     grades vs            │
 intent +                                                  pinned criteria    fail ─► feedback ─► retry
 done-criteria)                                            by tier
```

- **Planner** (Opus) compiles your `HIVE.md` into a plan.
- **Generator** (Opus / Sonnet) writes the code.
- **Evaluator** (Opus) grades the result against your **Success Criteria** — running `[auto]` checks for real, judging `[judge]` ones, gating `[human]` ones — and loops until they hold.

Same shape as Terraform or a Kubernetes reconcile loop: declare the desired state, a controller drives reality toward it — except here the desired state is *what "done" means*, and the controller is a build loop.

## Get started (60 seconds)

```bash
git clone https://github.com/jrobnc/hivekit && cd hivekit
npm install && npm run build

# end-to-end example: a HIVE.md that builds a slugify util with tests
./bin/hivekit --cwd examples/hello-hive
```

hivekit auto-discovers the `HIVE.md`, compiles it, builds `src/slugify.js` + a test, and the Evaluator runs `npm test` to confirm the `[auto]` criteria — then writes a report with a **Pinned Criteria Verification** table.

Point it at your own project:

```bash
hivekit --intent HIVE.md --cwd ~/dev/my-app    # or drop a HIVE.md in the dir and omit --intent
```

## HIVE.md — intent-as-source

A `HIVE.md` is human-authored markdown (**not** YAML). Every **Success Criterion** declares *how it is verified*:

```markdown
# HIVE.md
## Objective
Add a CSV export button to the reports page.
## Success Criteria
- [auto]  GET /reports/:id/export.csv returns 200 text/csv; an integration test covers 0 rows and many.
- [judge] Column order + headers match what's on screen — intuitive in a spreadsheet.
- [human] Sign-off that the file opens cleanly in Excel and Google Sheets.
## Constraints
Use the existing reports query + auth; no new dependencies.
## Out of Scope
No XLSX/PDF; no scheduled exports.
```

| Tier | Meaning | hivekit does |
|---|---|---|
| `[auto]` | programmatic — a test / command / exit code | **runs the real check**, gates on the result |
| `[judge]` | qualitative — an LLM judges against your words | scores it; scale to a panel for high stakes |
| `[human]` | needs a person | flags it as a gate; **never self-declares it done** |

> A criterion with no verifier is a wish, not a criterion. The tier sets autonomy — `[auto]` runs free, `[human]` stops at a gate. Full spec: **[docs/HIVE_SPEC.md](docs/HIVE_SPEC.md)**.

## Anatomy of a run — what a spec turns into

A `HIVE.md` isn't "executed" directly. hivekit **compiles it to a markdown plan, builds against the plan, then reconciles the result against your pinned criteria.** No YAML, no DSL — every intermediate artifact is human-readable markdown you can open and inspect.

```
1. HIVE.md           you write it: Objective + Success Criteria (tagged) + Constraints + Out of Scope
        │
        ▼  Planner (Opus) reads the HIVE.md + the target repo, COMPILES →
2. plan.md           generated markdown: technical design + an ordered sprint plan whose
        │            "definition of done" is your Success Criteria, carried in verbatim
        ▼  Generator builds the code against plan.md (one sprint at a time)
3. working code      real edits in the target repo
        │
        ▼  Evaluator (Opus) grades the result against the PINNED criteria, by tier
4. report.md         a Pinned Criteria Verification table:
                       [auto]  → it runs the actual test/command and records the real result
                       [judge] → it scores against your words
                       [human] → marked PENDING — the run can't self-clear it
        │
        ├── all non-[human] criteria pass → done
        └── any fail → the Evaluator's feedback string is fed back to the Generator (step 2/3),
                       up to --max-turns rounds. The loop, not the model, decides pass/fail.
```

All of these land in `.claude/harness/{run-id}/` in the target project (see [Artifacts](#artifacts)), so a run is fully auditable after the fact — you can read exactly what it planned, built, and how it graded itself.

## Modes

Beyond `HIVE.md` builds, hivekit runs three modes against any codebase:

| Mode | What it does |
|---|---|
| **review** | 3–7 parallel specialist agents (one per dimension) → one deduplicated, scored report |
| **build** | implement features from a plan or a `HIVE.md`; Evaluator gates on quality + your criteria |
| **improve** | targeted refactors with regression checks |

```bash
hivekit "review the auth module" --depth deep --cwd /path/to/project
hivekit "build user authentication" --mode build --cwd /path/to/project
hivekit "fix the bugs from the last review" --mode improve --cwd /path/to/project
```

Every agent inherits a shared set of [operating principles](src/prompts/principles.md) (smallest correct change, reuse over add, earn complexity) — and the Evaluator scores **Restraint** as a gate, so unjustified complexity fails a round.

## When to use · when to skip

hivekit has real overhead: minutes per run, dollars of tokens, and a spec to write — plus you should
verify the result, because the loop can pass its own evaluation and still be wrong. So the rule is:
**reach for it when the cost of getting it wrong exceeds that overhead. Otherwise just do the work.**

A quick test — if you answer "no" to all three, do it by hand:
1. Is the blast radius bigger than I can hold in my head? (multi-file, unfamiliar codebase, regression-risky)
2. Is getting it wrong expensive? (security, data integrity, money, public-facing)
3. Can I write a *checkable* done-condition I'd want enforced? (if not, hivekit is the wrong tool)

**Reach for it when**
- ✅ Multi-file features, or work in a codebase you don't know well (the Planner explores for you)
- ✅ Security / data-integrity / regression-risky changes where a missed edge case is costly
- ✅ You want an adversarial second opinion (**review** mode) or regression-gated edits (**improve** mode)
- ✅ "Done" is genuinely checkable and you want it pinned + version-controlled

**Skip it when**
- ➖ A single-file or few-line change you could type faster than the spec
- ➖ Anything you can hold entirely in your head; a typo / config tweak / copy edit
- ➖ Exploratory work where you're still figuring out *what* you want (no pinnable done-condition)

> **Modes have different thresholds.** `review` is the cheapest to justify — it only reads and
> reports, so pointing it at code you're unsure about is low-risk, high-value. `build` and `improve`
> change code you then have to verify, so they need a stronger reason. When in doubt: review is the
> safe reach; build/improve need a real one.

## Install

```bash
npm install
npm run build
```

Requires **Node.js 20+** and Claude Code authenticated — a **Claude Max subscription works (no API key needed)**, or set `ANTHROPIC_API_KEY` for API billing.

<details>
<summary><b>macOS auth note (Claude Max via subprocess)</b></summary>

hivekit spawns `claude` as a subprocess via the Agent SDK; that subprocess can't reach the macOS Keychain where the OAuth token lives, so it 401s unless the token is in the environment. Export it once per shell:

```bash
cat > ~/.zshenv <<'EOF'
export CLAUDE_CODE_OAUTH_TOKEN=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['claudeAiOauth']['accessToken'], end='')" 2>/dev/null)
EOF
source ~/.zshenv
```

`~/.zshenv` is sourced by every zsh invocation, so the token propagates to the subprocess and refreshes each shell start.
</details>

## Billing — Claude Max by default

hivekit routes through your Claude Max subscription via OAuth. To stop a stray `ANTHROPIC_API_KEY` (a sourced `.env`, a parent shell, an MCP context) from silently switching you to metered API billing, the launcher strips it **before Node starts**:

```bash
exec env -u ANTHROPIC_API_KEY node dist/index.js "$@"   # bin/hivekit
```

A top-of-file `delete process.env.ANTHROPIC_API_KEY` would be too late — ES modules are hoisted, so the SDK can resolve credentials before any statement in `src/index.ts` runs. **Invoke the wrapper** (`./bin/hivekit`), not `node dist/index.js`. To deliberately bill API for a run, set `HARNESS_ALLOW_API_KEY=1`.

## CLI flags

| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `--intent` | file path | auto-discovered | Drive the run from a `HIVE.md` / `intent.md` |
| `--yaml` | flag | off | Also emit a structured `intent.yaml` alongside the markdown artifacts (machine view for tooling; markdown stays the source of truth) |
| `--mode` | `review`, `build`, `improve` | inferred | Run mode |
| `--depth` | `quick`, `standard`, `deep` | `standard` | Agent thoroughness |
| `--focus` | string | none | Focus area (e.g. `ios`, `auth`) |
| `--cwd` | path | cwd | Target project directory |
| `--sprint` | integer | none | Scope a build to one sprint of the plan |
| `--plan` | file path | none | Reuse an existing plan (skip the planner) |
| `--max-turns` | integer | 100 / 60 / 40 | Max turns per agent |

## Under the hood — the implementation path

The control loop is plain TypeScript (`src/`, compiled to `dist/`); the LLM only runs inside bounded agent phases. A run flows through these modules:

```
bin/hivekit              strips ANTHROPIC_API_KEY, then runs dist/index.js   (Claude Max OAuth stays the only credential)
  └─ src/index.ts        CLI parse → resolveIntent() → Planner→Generator→Evaluator loop (≤ maxEvalRounds)
       ├─ src/intent.ts  loadIntent(): parse HIVE.md → Objective + Success Criteria with [auto|judge|human] tiers
       │                 intentCompilePreamble() feeds the Planner; formatCriteriaForEvaluator() pins the rubric
       ├─ src/planner.ts    Opus agent reads the HIVE.md + the target repo (incl. its CLAUDE.md) → writes plan.md
       ├─ src/generator.ts  build: 1 Opus agent · review: 3–7 parallel Sonnet · improve: 1–3 parallel Opus
       └─ src/evaluator.ts  Opus agent grades the result vs the pinned criteria → parseEvaluation() gate
                            pass → report.md   ·   fail → feedback string → back to the Generator
  shared:
       ├─ src/sdk-utils.ts  runAgent() wraps the Agent SDK; loadPrinciples() injects the guardrails
       ├─ src/prompts/*.md  9 phase templates ({planner,generator,evaluator}-{review,build,improve})
       └─ src/prompts/principles.md   the operating guardrails injected into every agent
```

**Key design choices, and where they live:**
- **The gate is a pure function.** `parseEvaluation()` (`src/evaluator.ts`) decides pass/fail by reading the Evaluator's scored criteria — it fails *closed* on a near-miss FAIL marker, and it's the most-tested unit in the repo (`test/evaluator.test.mjs`). The orchestrator, not the model, owns the loop.
- **The human pins the rubric, not the model.** Without a `HIVE.md` the Planner invents its own success criteria (then gets graded on them). With one, `formatCriteriaForEvaluator()` injects your criteria verbatim — `[auto]` runs the real check, `[judge]` scores, `[human]` becomes a gate the run can't self-clear.
- **Context is repo-local, by design.** Each agent reads the *target project's* own conventions (its `CLAUDE.md`, neighboring code) for context. hivekit deliberately carries **no** personal/global memory layer — it operates on the repo in front of it, nothing else.
- **Lenient parser, no schema.** `src/intent.ts` extracts only what must be structured (the criteria + tiers); everything else in the `HIVE.md` the Planner just reads. No YAML, no validator (see [docs/HIVE_SPEC.md](docs/HIVE_SPEC.md) §2).

## Artifacts

Each run writes a namespaced directory in the target project:

```
.claude/harness/{run-id}/
├── plan.md       # Planner spec (compiled from HIVE.md, if given)
├── progress.md   # Generator progress
├── report.md     # Evaluator report (+ Pinned Criteria Verification for HIVE.md runs)
└── findings/     # review mode only
```

## Development

```bash
npm run dev    # run via tsx (no build step)
npm run build  # compile TypeScript
npm test       # build + run the test suite (node --test)
```

## License

[Apache-2.0](LICENSE) · by [Jody Roberts](https://github.com/jrobnc).
