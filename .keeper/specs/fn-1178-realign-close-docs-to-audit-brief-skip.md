## Overview

Task .1 of the source epic changed `selection-audit-brief` so a re-close on an
already-committed brief returns `{success:true, skipped:true}` and the verb no
longer emits `REVIEW_EXISTS` at all. Two docs still describe the old behavior:
the close SKILL's Phase 3.6a branch table documents an unreachable `REVIEW_EXISTS`
branch (and has no branch for the actual `skipped:true` envelope, so a re-close
is mislabeled `no auditable cells`), and `docs/problem-codes.md` still lists
`selection-audit-brief` as a `REVIEW_EXISTS` emitter. This is a small doc-accuracy
sweep aligning both surfaces with the shipped verb contract.

## Acceptance

- [ ] The close SKILL's Phase 3.6a branch table documents the `skipped:true` re-close envelope (logging `already captured (re-close)`) and drops the now-unreachable `REVIEW_EXISTS` branch.
- [ ] `docs/problem-codes.md`'s `REVIEW_EXISTS` row scopes "emitted by" to `selection-review-submit` only, with the audit-brief's idempotent-skip behavior noted in the section prose.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Post task .1 the verb emits zero REVIEW_EXISTS and returns skipped:true on an existing brief, so SKILL.md line 234's REVIEW_EXISTS branch is unreachable and the skipped envelope has no documented branch. |
| F2 | merged-into-F1 | .1 | F2 (problem-codes.md line 172 still lists selection-audit-brief as a REVIEW_EXISTS emitter) shares F1's root cause and lands in the same doc-sweep, so F2 folds into F1's task. |

## Out of scope

- Any change to `selection_audit_brief.ts` or `selection_review_submit.ts` behavior — the verb contract is correct as shipped; only the docs drift.
- The migration, projection sweep, or `/plan:cell-review` skill from the source epic — the auditor cleared them.
