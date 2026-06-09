## Description

Fix two stale string references in `src/rpc-handlers.ts` `parseDispatchKey` — both missed when fn-760 dropped `approve` from `RETRY_DISPATCH_VERBS`:

- F1: `rpc-handlers.ts:385` — error message `` `verb` must be one of work|close|approve `` → change to `work|close`
- F2: `rpc-handlers.ts:351` — JSDoc line `` `verb` is one of `work` / `close` / `approve`. `` → remove `` / `approve` ``

Both are one-liner edits in the same function. No behavioral change.

## Acceptance

- [ ] Line 385 error string reads `work|close` with no mention of `approve`
- [ ] Line 351 docstring lists only `work` / `close`
- [ ] Tests pass (`bun test`)

## Done summary

## Evidence
