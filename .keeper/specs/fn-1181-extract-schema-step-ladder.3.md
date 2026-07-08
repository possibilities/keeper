## Description

**Size:** S
**Files:** docs/adr/0021-schema-step-ladder.md, docs/adr/0020-schema-version-renumber-at-merge-time.md, CLAUDE.md, CONTEXT.md

### Approach

Record the landed structure. New ADR (next free number): the explicit-version step-ladder
decision — entry shape, kind discriminant, derived constant, test-derived (not generated)
whitelist, and the REJECTED alternatives (position-derived numbers per the framework-survey
hazard; api.py codegen per narrative/Black cost). Amend ADR 0020's Status with a note that
the hand-renumber mechanism it describes is partially superseded by the ladder ADR (0020's
trunk-keeps-its-numbers rule still governs). Rewrite CLAUDE.md's Migrations bullet about
the "THREE same-commit moves" to the ladder reality — the file sits AT its lint byte cap,
so this is a replace-and-trim edit, never an append; keep `bun scripts/lint-claude-md.ts`
green. Add CONTEXT.md glossary entries (1-2 sentences + Avoid line each) for: Migration
ladder (the ordered explicit-version step entries; Avoid: registry — that word belongs to
Usage-model registry), Additive-idempotent step, and Schema singleton (the one-lane-at-a-
time nature of the schema surface). Forward-facing prose only — state the current
structure, no incident narration outside the ADR.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- docs/adr/0020-schema-version-renumber-at-merge-time.md — the record being amended
- CLAUDE.md Migrations section — the bullet being rewritten
- CONTEXT.md — existing glossary genre + the Usage-model registry entry (term-collision source)

**Optional** (reference as needed):
- docs/adr/0004-forward-only-migrations.md — the base record both ADRs build on

### Risks

- CLAUDE.md byte cap: the rewrite must land net-negative or net-zero bytes; run the lint before committing.

## Acceptance

- [ ] The new ADR passes the three-part test on its face (hard to reverse, surprising without context, resolved a real trade-off) and records both rejected alternatives
- [ ] ADR 0020's Status carries the amendment note; its file is otherwise untouched
- [ ] `bun scripts/lint-claude-md.ts` green after the CLAUDE.md rewrite
- [ ] CONTEXT.md defines the three terms with Avoid lines and zero implementation detail

## Done summary
Added ADR 0022 for the explicit-version schema step ladder, amended ADR 0020's Status with a partial-supersession note, rewrote CLAUDE.md's Migrations bullet net-negative to the ladder reality, and added CONTEXT.md glossary entries for Migration ladder, Additive-idempotent step, and Schema singleton.
## Evidence
