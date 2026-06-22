## What and why

What this changes and the motivation. Link the issue or the PLAN.md item it traces to.

## Checklist

- [ ] `npm run verify` passes (tsc + full suite) against local Postgres 16 on port 5440.
- [ ] Behavior changes are covered by a new or extended test in `test/`.
- [ ] Docs updated if external behavior, architecture, or usage changed (README / USING /
      docs/architecture.md).
- [ ] Dependency, schema, module-boundary, or invariant changes have a `docs/decisions/` file.
- [ ] Schema changes are additive, reversible, and idempotent.
- [ ] No secrets added; tokens stay hashed; `.env` not committed.
- [ ] Conventional Commit messages; `Signed-off-by:` present (DCO).
- [ ] Style: no em dashes, no emoji, terse prose.

## Invariants touched

List any of the seven CLAUDE.md §02 invariants this change affects, and how the guard test stays
green. Write "none" if not applicable.
