# HIVE.md

## Objective
Add a `slugify` utility that turns an arbitrary string into a URL-safe slug, with tests.
This is the end-to-end proof target for the HIVE.md intent-as-source loop — small, real,
and verifiable by an actual test run.

## Success Criteria
- [auto] `npm test` passes in this directory, including a test file for `slugify` that covers: spaces become hyphens, mixed/upper case becomes lowercase, and leading/trailing/duplicate separators are collapsed.
- [auto] `slugify` is exported as a named ESM export from `src/slugify.js`.
- [judge] The implementation is minimal and idiomatic — a small pure function, no new dependencies, no over-engineering.

## Constraints
- No new dependencies; use only Node built-ins and the existing `node --test` runner.
- Keep it to `src/slugify.js` plus a colocated test (e.g. `src/slugify.test.js`).

## Out of Scope
- No CLI, no build tooling, no transliteration of non-Latin scripts.
