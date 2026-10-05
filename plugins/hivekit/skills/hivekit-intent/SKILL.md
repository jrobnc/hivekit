---
name: hivekit-intent
description: Help the user write a good HIVE.md intent file with checkable success criteria.
cli: false
---

# hivekit-intent

This is a guidance skill — it does not run a CLI command. Use it to help users write or improve a `HIVE.md` intent file so their HiveKit builds have clear, checkable done-conditions.

## When to use

Use this skill when the user asks for help writing a HIVE.md, defining success criteria, or structuring an intent file for a build.

## HIVE.md format

A `HIVE.md` has four sections:

### 1. Objective

A short paragraph stating what you want built and why. Focus on the outcome, not the steps.

### 2. Success Criteria

A checklist of conditions that must hold when the build is done. Each criterion is tagged with a verification tier:

| Tier | Tag | Meaning |
|---|---|---|
| Automated | `[auto]` | Can be verified by running a command (test suite, linter, type check, build). |
| Judge | `[judge]` | Verified by the Evaluator agent reading code or output (e.g., "error messages are user-friendly"). |
| Human | `[human]` | Requires a person to verify (e.g., "animation feels smooth"). Skipped in automated runs. |

### 3. Constraints

Boundaries the build must respect (e.g., "no new npm dependencies", "must support Node 18+").

### 4. Out of Scope

What to explicitly skip, to prevent scope creep.

## Good vs. bad success criteria

### Good (checkable)

```markdown
## Success Criteria
- [auto] `npm test` passes with zero failures
- [auto] `npm run build` completes with exit code 0
- [auto] The `/api/users` endpoint returns 200 for a valid GET request
- [judge] Error responses include a human-readable `message` field
- [judge] No API key or secret appears in any committed file
- [human] The login page renders correctly on mobile Safari
```

### Bad (vague, uncheckable)

```markdown
## Success Criteria
- Code is clean and well-structured
- Performance is good
- Everything works
- The UI looks nice
```

**Why these are bad:** "clean", "good", "works", and "nice" have no observable check. The Evaluator cannot verify them. Rewrite each as a specific, observable condition.

## Example HIVE.md

```markdown
# HIVE.md

## Objective

Add JWT-based authentication to the Express API so that protected endpoints
require a valid token.

## Success Criteria

- [auto] `npm test` passes with zero failures
- [auto] `POST /auth/login` returns a JWT for valid credentials
- [auto] `GET /api/protected` returns 401 without a token
- [auto] `GET /api/protected` returns 200 with a valid token
- [judge] Tokens expire after 1 hour (check the `expiresIn` config)
- [judge] Password hashing uses bcrypt with cost factor >= 10
- [human] Login error messages do not reveal whether the email exists

## Constraints

- No new npm dependencies beyond `jsonwebtoken` and `bcrypt`
- Must work with the existing PostgreSQL user table

## Out of Scope

- OAuth / social login
- Password reset flow
- Rate limiting
```

## Full specification

See [HIVE_SPEC.md](../../../../docs/HIVE_SPEC.md) for the complete format, including advanced features like multi-sprint criteria and intent composition.

## Safety rules

- **Never author success criteria that require pushing, deploying, merging, or releasing code.** Those actions require explicit user approval and must not be automated via success criteria.
