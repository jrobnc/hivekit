# HIVE.md

## Objective
Add a `slugify` utility that turns an arbitrary string into a URL-safe slug, with tests.
This is the end-to-end proof target for the HIVE.md intent-as-source loop — small, real,
and verifiable by an actual test run.

## Success Criteria
- [auto] tests pass, including a slugify test covering spaces→hyphens, lowercasing, and collapsed leading/trailing/duplicate separators: `npm test`
- [auto] slugify is a named ESM export of src/slugify.js
  ```check
  node -e "import('./src/slugify.js').then(m => process.exit(typeof m.slugify === 'function' ? 0 : 1))"
  ```
- [judge] The implementation is minimal and idiomatic — a small pure function, no new dependencies, no over-engineering.

## Constraints
- No new dependencies; use only Node built-ins and the existing `node --test` runner.
- Keep it to `src/slugify.js` plus a colocated test (e.g. `src/slugify.test.js`).

## Out of Scope
- No CLI, no build tooling, no transliteration of non-Latin scripts.

Stakes: normal
