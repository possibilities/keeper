## Overview

The domain-knowledge epic re-homed decision history to docs/adr + commit
messages, but the README front door still carries a pre-existing line that
points rationale/provenance at `.keeper/` specs and git history — directly
beside the new line pointing resolved decisions at docs/adr. The lean
front door now gives two answers for where decision history lives, one of
them contradicting the epic's own CLAUDE.md single-home canon. This is a
small docs consolidation to make the front door state one coherent map of
doc homes.

## Acceptance

- [ ] README states one non-contradictory map of doc homes (vocabulary -> CONTEXT.md, decisions -> docs/adr, plan/spec archive -> .keeper/ specs)
- [ ] No README line asserts rationale/decision history lives in a home other than docs/adr + commit messages, per CLAUDE.md rule-0

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | README.md line 5 (rationale/provenance -> .keeper/ specs + git history) contradicts line 8 (decisions -> docs/adr) and the epic's CLAUDE.md single-home-for-rationale canon; front door gives two answers for where decisions live. |

## Out of scope

- context-hint.ts unit test (auditor declined: hooks are exercised in-vivo, identical scan path)
- Any linter, brief, or hook code change — the audit confirmed those surfaces match spec with no drift
