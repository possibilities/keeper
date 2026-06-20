## Overview

Two stale string references to `approve` as a valid `retry_dispatch` verb remain in `parseDispatchKey` after fn-760 narrowed `RETRY_DISPATCH_VERBS` to `{work, close}`. The error message (line 385) actively misleads callers; the docstring (line 351) contradicts the updated type. Both are one-liner fixes in the same function.

## Acceptance

- [ ] `src/rpc-handlers.ts:385` error message reads `work|close` (no `approve`)
- [ ] `src/rpc-handlers.ts:351` docstring lists only `work` / `close` as valid verbs

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Stale error message confirmed at rpc-handlers.ts:385 — says work\|close\|approve but approve is rejected; misleads every caller who hits this error path |
| F2 | kept | .1 | Stale docstring confirmed at rpc-handlers.ts:351 — same function, lists approve as valid; direct miss of fn-760's stated goal |

## Out of scope

- Adding a string-pin test for the error message (auditor explicitly deems not worth a brittle test)
- Any other approve references outside parseDispatchKey
