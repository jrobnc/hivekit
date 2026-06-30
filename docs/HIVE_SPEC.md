# HIVE.md — Intent-as-Source Specification

**Status:** v0.1 · **Reference compiler:** [hivekit](../README.md) (this repo)

A `HIVE.md` is a human-authored, version-controlled **desired-state file** that drives an
agent run. You state the outcome and what "done" means; the compiler (harness) figures out
the steps, does the work, and reconciles against your criteria until they hold.

It is the smallest complete instruction: when you compress a prompt until nothing
compressible is left, what remains is the goal and the definition of done. That residue is
`HIVE.md`.

> **Canonical name:** `HIVE.md`. **Accepted alias:** `intent.md` (for interop with
> Pathmode-style files). The compiler reads either; `HIVE.md` wins if both exist.

---

## 1. The shape (why this exists)

Declarative desired state + a reconciliation loop. You describe the state you want; the
platform takes responsibility for getting there. In Kubernetes terms: `HIVE.md` is the
manifest, the harness's Planner→Generator→Evaluator loop is the controller, and the
Evaluator computes the diff between desired (your Success Criteria) and actual (the result),
re-running until they converge.

The hard part of that loop is the **diff** — and in agent systems the diff is often a
judgment, not a number. So this spec's center of gravity is the **verifier**: every criterion
must declare *how you'd know it's met*.

```
HIVE.md            ← you write this: WHAT + WHY + how DONE is judged   (the source)
   │  Planner COMPILES
   ▼
plan.md            ← generated: HOW + sprints                           (the artifact)
   │  Generator builds  (carries principles.md / Ponytail guardrails)
   ▼
Evaluator reconciles result vs HIVE.md Success Criteria → pass | iterate
```

`HIVE.md` is the **source**; `plan.md` is the **compiled** artifact. The existing `--plan`
flag stays as the "skip compilation, reuse this plan" escape hatch.

---

## 2. The file format

Markdown prose with `##` section headings. **Not YAML.** You write sentences; the model
interprets them. There is no rigid schema and no validator — leniency is intentional.

| Section | Required | Purpose |
|---|---|---|
| `## Objective` | **Yes** | What outcome, and why. 1–3 sentences. |
| `## Bet` | Optional | A *falsifiable* hypothesis the work is testing — "if X, then metric Y moves from A→B, measured over Z." Sharpens intent and surfaces the real goal. See note below. |
| `## Success Criteria` | **Yes** | How "done" is judged. Each line carries a **verifier tag** (§3). This *is* the reconciler's diff function. |
| `## Constraints` | Recommended | What must hold / must not change — stack, budget, deadline, "don't touch X". |
| `## Out of Scope` | Recommended | Explicit non-goals. The restraint boundary; keeps the compiler from sprawling. |
| `## Evidence` | Optional | Pointers to source material (links, files, notes). Context discipline applies: the Planner cites/summarizes, does not dump. |
| `## Audience` | Optional | Who it's for / the "first win" — the fastest path to a real outcome for the user. |

> **On `## Bet` — falsifiable intent.** Instead of "build onboarding," write: *"If new users
> finish onboarding in under 90s, activation rises from 42% to 55%, measured over 7 days."* This
> forces the real goal into the open. **Honest limit:** a Bet is usually a *production* metric, which
> the build-time loop **cannot** verify — so its acceptance is a `[human]` (or future production-
> reconciliation) criterion, not an `[auto]` one. The Bet shapes *what* to build and *how to judge it
> later*; don't mistake stating a Bet for being able to check it at build time.

Only **Success Criteria** flow structurally to the Evaluator. Everything else is read by the
Planner as compilation context. Unknown sections are ignored, not errors.

---

## 3. Verifier tiers — the heart of the spec

Every Success Criterion declares *how it is verified*. The axis is not "checkable vs prose";
it is **"what is the verifier, and how much do we trust it."** Three tiers:

- **`[auto]` — programmatic.** A test passes, a command exits 0, a number is within a band
  (`margin < 0.20`). Cheap, total, trustworthy. The strongest verifier.
- **`[judge]` — LLM-judge against a rubric.** "Does the weekly grid read as calm, not
  alarming, to a stressed parent?" Noisier than `[auto]`, but **real** — and the *only*
  verifier that exists for qualitative outcomes. This tier is where LLM judgment earns its
  keep; it is first-class, not a fallback. (The harness's own **Restraint** criterion is a
  `[judge]` criterion with no number, and it works.)
- **`[human]` — human gate.** Subjective, high-stakes, or no cheap proxy. A person signs off.
  The loop may do the mechanical work but **must not self-declare this done.**

### The rules

- **Hard rule (anti-theater, cheap to satisfy):** every Success Criterion names a tier.
  A criterion with no verifier is a wish, not a criterion. You cannot leave it blank.
- **Soft rule (author's judgment):** reach for the strongest verifier that is *cheap and
  natural*. **Do not contort a qualitative outcome into a fake metric** just to get an
  `[auto]` — that invites Goodhart's law (the proxy becomes the target and the real goal
  rots). Use `[judge]` when thinking is the point.
- **Tier sets autonomy, not legitimacy:** `[auto]` → the loop runs free. `[judge]` → the loop
  runs, and the *stakes* decide whether one judge suffices or you want a panel / adversarial
  second opinion. `[human]` → the loop reconciles everything else and then **stops at a gate**.

> Control-theory framing: a `[judge]` is a *noisy sensor*. The answer to a noisy sensor is not
> "only use perfect sensors" — it is "know the noise and don't crank the gain past what the
> sensor supports." So you don't point a fully autonomous, high-stakes, no-human reconciler at
> a `[judge]` without damping (a panel / adversarial verify) or a `[human]` gate. To make
> judgment *more* trustworthy, strengthen the judge (independent evaluator, multiple lenses,
> a better rubric) — do **not** numericize it.

---

## 4. The compiler contract (what the harness does)

1. **Compile.** Planner reads `Objective` + `Constraints` + `Out of Scope` + `Evidence` +
   `Audience`, and writes `plan.md` (sprints, technical design). Existing machinery.
2. **Pin the rubric.** `Success Criteria` become the Evaluator's grading rubric **verbatim** —
   human-set, not Planner-invented. (Today the Planner invents the criteria it is later graded
   on; `HIVE.md` removes that conflict of interest.)
3. **Route by tier:**
   - `[auto]` → the Evaluator runs the actual check (executes the test/command) and gates on
     the real result, not its impression.
   - `[judge]` → the Evaluator scores the criterion against the rubric; for high-stakes
     criteria, scale to an independent panel / adversarial verify.
   - `[human]` → the Evaluator marks **pending human sign-off** and the run terminates at that
     gate without declaring success.
4. **Restraint is implicit.** The Ponytail `Restraint` criterion (from `principles.md`) always
   applies on top of the authored criteria — smallest correct change, no unjustified
   complexity — so `HIVE.md` runs inherit the guardrails for free.
5. **Reconcile.** Generator↔Evaluator loop runs until all non-`[human]` criteria pass or the
   iteration ceiling / budget is hit (a loop is not a free function call — deadlines and
   budgets are first-class).

---

## 5. Worked example — a CSV export feature

```markdown
# HIVE.md

## Objective
Add a CSV export button to the reports page so a user can download the current report as a
spreadsheet in one click.

## Audience
Users who need to analyze or share a report outside the app. First win: open a report, click
Export, get a valid CSV of exactly what's on screen.

## Success Criteria
- [auto] GET /reports/:id/export.csv returns 200 with a `text/csv` body whose rows match the
  report's rows; an integration test covers a report with 0 rows and one with many.
- [auto] Existing reports-page tests still pass (no regression).
- [judge] The CSV column order and headers match what's shown on screen — intuitive to a user
  opening it in a spreadsheet, not raw internal field names.
- [human] Sign-off that the exported file opens cleanly in Excel and Google Sheets.

## Constraints
- Use the existing reports query and auth; no new dependencies; stream large exports.

## Out of Scope
- No XLSX or PDF formats; no scheduled or emailed exports.
```

The loop reconciles the two `[auto]` and the `[judge]` criteria autonomously, then stops at
the `[human]` gate for the spreadsheet-compatibility sign-off — it does not declare that
outcome done on its own.

---

## 6. Invocation (sketch)

```bash
# explicit
harness --intent HIVE.md --cwd ~/dev/my-app
# auto-discovery: a HIVE.md (or intent.md) in --cwd is picked up automatically
harness --cwd ~/dev/my-app
```

`HIVE.md` coexists with the bare `task` string (kept for quick one-offs). If both are present,
the file is the source of truth and the string is treated as a hint.

---

## 7. What this spec deliberately is NOT (restraint boundary)

- **No rigid schema / validator.** The Planner reads markdown; the model compiles it. Only
  Success Criteria need structured extraction (the tier tag).
- **No DSL, no YAML authoring.** YAML, if it ever appears, is a hidden compiled execution
  graph in a larger system — never hand-written here.
- **No marketplace, no platform, no cross-domain compiler — yet.** Those are strategy. The v0.1
  goal is: a `HIVE.md` drives one real harness build, end to end, with the verifier tiers
  honored. Prove the file→run loop before generalizing to larger platforms or non-code
  domains.

---

## 8. Resolved decisions (v0.1)

1. **Tier syntax — inline.** `- [auto|judge|human] <text>` per criterion. Each criterion is
   self-describing; no separate grouping.
2. **Default tier — `[human]` (fail safe).** An untagged bullet under `## Success Criteria` is
   treated as `[human]`, forcing a sign-off gate rather than silently auto-passing.
3. **Evidence compression — deferred.** No proven need yet; revisit when a run actually chokes
   on large Evidence. (The one honest Headroom hook, parked.)
4. **Location — with the reference compiler** (`harness/docs/`) for now; graduates to its own
   repo if/when the standard goes public.
```
