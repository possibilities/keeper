## Overview

The `robotRung` doc-comment in `src/dash/view-model.ts` documents the
function's precedence ordering, but that header still asserts the pre-fix
order (annotation stamps ahead of terminal state) while the body now
resolves `ended`/`killed` first. This is a docs-correctness fix: align the
contract description with the code so the next reader of a precedence-defining
function is not misled into the inverse order.

## Acceptance

- [ ] The `robotRung` doc-comment header states the current precedence with
      terminal-state resolution leading (ended/killed before the annotation
      and base-state checks).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | view-model.ts:103-104 doc-comment asserts the OLD precedence (api-error before ended/killed), the inverse of the body — a stale contract that misleads the next reader. |

## Out of scope

- The function body and band/visibility wiring (already correct per audit).
- Test changes (audit found no test gap).
