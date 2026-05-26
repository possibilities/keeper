## Description

Finding `api-error-kinds-drift` (fn-616-generalize-api-error-pill audit): the five-kind `ReadonlySet<ApiErrorKind>` is independently declared in `src/reducer.ts:161` (`API_ERROR_KINDS`) and `src/transcript-worker.ts:171` (`DISPATCHED_API_ERROR_KINDS`). Evidence: both files declare `new Set(["rate_limit","authentication_failed","billing_error","server_error","invalid_request"])` with no import relationship. A future kind addition to one without the other causes the matcher to silently emit a kind the reducer folds to `"unknown"`, producing wrong board pill labels.

Fix: export a single `API_ERROR_KINDS: ReadonlySet<ApiErrorKind>` const from `src/types.ts`, delete the local declarations in `reducer.ts` and `transcript-worker.ts`, and import from `types.ts` in both. Update JSDoc cross-references in both files to point to the shared source.

## Acceptance

- [ ] `src/types.ts` exports `API_ERROR_KINDS: ReadonlySet<ApiErrorKind>` containing the five dispatch-terminal kinds (no `"unknown"`).
- [ ] `src/reducer.ts` imports and uses the shared const; its local `API_ERROR_KINDS` literal is removed.
- [ ] `src/transcript-worker.ts` imports and uses the shared const; its local `DISPATCHED_API_ERROR_KINDS` literal is removed.
- [ ] All existing tests pass (bun test).

## Done summary

## Evidence
