## Overview

The five-kind `ApiErrorKind` allow-list is currently declared as independent `ReadonlySet<ApiErrorKind>` literals in both `src/reducer.ts` (`API_ERROR_KINDS`) and `src/transcript-worker.ts` (`DISPATCHED_API_ERROR_KINDS`). With no runtime or compile-time binding between them, a future kind addition risks a silent mismatch: the matcher emits a kind the reducer folds to `"unknown"`, producing wrong pill labels on the board. Hoist a single shared constant into `src/types.ts` and import it in both consumers.

## Acceptance

- [ ] A single `API_ERROR_KINDS` (or equivalent) const is exported from `src/types.ts` and imported in both `src/reducer.ts` and `src/transcript-worker.ts`; no independent `Set` literals remain in either consumer.
- [ ] The shared const is typed `ReadonlySet<ApiErrorKind>` and includes the same five kinds as today (`rate_limit`, `authentication_failed`, `billing_error`, `server_error`, `invalid_request`), excluding `unknown`.
- [ ] Existing tests pass without modification; test `test.each` arrays in `test/board.test.ts` are updated to import from the shared const or remain as literal arrays (either is acceptable — the goal is the runtime Sets, not the test arrays).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| api-error-kinds-drift | kept | .1 | Both `ReadonlySet<ApiErrorKind>` literals are identical with no cross-file binding; `reducer.ts` JSDoc says "updated in lockstep" but scopes that to type↔set within that file only; future kind addition would naturally land in `reducer.ts` and could silently miss `transcript-worker.ts`. |

## Out of scope

- Changing the set of dispatched kinds (that is a separate product decision).
- Updating `test/board.test.ts` test arrays to import the shared const (test literals are fine as-is; the board tests gate observable rendered output, not the Set identity).
