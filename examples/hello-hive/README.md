# hello-hive — HIVE.md end-to-end example

A self-contained target that proves the `HIVE.md` intent-as-source loop. The starter is just
`package.json` + `HIVE.md`; the harness generates `src/` from the intent (so `src/` and run
artifacts are gitignored — you regenerate them by running it).

## Run it

```bash
# from the harness repo root
./bin/harness --cwd examples/hello-hive
```

The harness auto-discovers `HIVE.md`, compiles it into a plan, builds `src/slugify.js` + a test,
and the Evaluator grades against the **pinned Success Criteria** — running `npm test` for the
`[auto]` ones and judging the `[judge]` one. A passing run writes `.claude/harness/<run>/report.md`
with a Pinned Criteria Verification table.

## Verify independently

```bash
cd examples/hello-hive && npm test
```

First proven **2026-06-21**: passed in round 1; independent `npm test` = 7/7; the Evaluator's
Pinned Criteria Verification confirmed all 3 criteria (`[auto]`/`[auto]`/`[judge]`) with
Restraint scored 98/100.
