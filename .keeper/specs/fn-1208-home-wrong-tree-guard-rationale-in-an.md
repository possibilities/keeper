## Overview

The `wrong-tree-guard` hook shipped with its incident rationale narrated
in the file header comment in past tense, and with no `docs/adr` entry —
both against repo rule #0, which mandates history and rationale live in
`docs/adr/` and bans past-tense provenance in code comments. This follow-up
moves that rationale into a new ADR (its canonical home) and rewrites the
hook comment to be forward-facing (what the guard does now), preserving the
knowledge the comment currently carries rather than pruning it away.

## Acceptance

- [ ] A new `docs/adr` entry captures the shared-checkout-dirtying rationale and the wrong-tree-guard decision.
- [ ] The `wrong-tree-guard.ts` header comment is forward-facing only, with no past-tense incident narrative.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | Best-effort audit hook scoped to the claimed Write\|Edit\|MultiEdit\|Bash set; .ipynb vector negligible in a Bun/TS repo, sole artifact a dead optional field. |
| F2 | merged-into-F3 | .1 | F2 (missing docs/adr entry) folds into F3's task: the ADR F3's comment rewrite requires is the same canonical-home deliverable F2 asks for. |
| F3 | kept | .1 | Header narrates a past incident verbatim, violating codified rule #0; fixed by moving rationale into a new docs/adr entry and rewriting the comment forward-facing. |
| F4 | culled | — | Same root cause as F1 (unused notebook_path field); a lone unread optional field is a speculative-generality nitpick below the keep bar. |

## Out of scope

- NotebookEdit / notebook_path guard coverage (F1, F4) — culled; the hook is best-effort audit and notebooks are negligible in this repo.
