## Description

**Size:** S
**Files:** src/rpc-handlers.ts, src/server-worker.ts, test/server-worker.test.ts (if it asserts the approve verb)

### Approach

The fn-756 strip collapsed `autopilot.Verb` (src/autopilot-worker.ts:160)
to `"work" | "close"` but left `"approve"` in the parallel retry-dispatch
verb surface. Remove it everywhere it survives: the `RetryDispatchVerb` type
and the `RETRY_DISPATCH_VERBS` Set in `src/rpc-handlers.ts`, and the three
`verb: "work" | "close" | "approve"` unions in `src/server-worker.ts`. Fix
the comment above `RetryDispatchVerb` that claims it "Mirrors the Verb union
in src/autopilot-worker.ts" — make it true again (or drop the claim). If any
test passes `"approve"` as a retry verb, update it. Run `bun test` to
confirm green. Purely a dead-surface removal — no behavior change (no
`approve::` dispatch can exist to retry).

### Investigation targets

**Required** (read before coding):
- src/rpc-handlers.ts:320-335 — RetryDispatchVerb type + RETRY_DISPATCH_VERBS Set + the "Mirrors the Verb union" comment
- src/server-worker.ts:236, :1281, :2836 — the three retry-dispatch verb unions
- src/autopilot-worker.ts:160 — the canonical `Verb = "work" | "close"` this should mirror

**Optional** (reference as needed):
- test/server-worker.test.ts — grep for "approve" retry-dispatch assertions

## Acceptance

- [ ] No `"approve"` remains in `RetryDispatchVerb` / `RETRY_DISPATCH_VERBS` / the server-worker.ts verb unions.
- [ ] The "Mirrors the Verb union" comment is accurate (or removed).
- [ ] `bun test` green.

## Done summary

## Evidence
