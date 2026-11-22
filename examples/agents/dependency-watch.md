---
name: dependency-watch
description: "Weekday check of outdated dependencies; writes a short report"
schedule: weekdays 07:30
project: example-app
principal: example-bot
output: report
budget_usd: 2
---
# Dependency watch

## Objective
Find outdated or vulnerable dependencies in the project and write a short, prioritised report.

## Constraints
- Read-only on source and lockfiles; only `reports/` may be written.
- Do not upgrade anything.

## Out of Scope
- Opening upgrade pull requests.
- Changing CI configuration.

## Success Criteria
- [auto] report written: `test -f reports/dependency-watch.md`
- [judge] Every listed dependency names its current version, the latest version and why it matters.
- [judge] The report is ordered by risk and a reader can act on the top item without more research.
