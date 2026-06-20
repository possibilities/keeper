## Description

**Size:** S
**Files:** cli/control-rpc.ts (new), cli/autopilot.ts, test/ (helper coverage)

Lift the file-local one-shot connect/query/close helper out of `cli/autopilot.ts`
into a shared module so the new dispatch handler can read the `epics`,
`pending_dispatches`, and `autopilot_state` collections (and not reach for the
never-exiting `subscribeCollection` loop).

### Approach

- Extract `roundTrip(sockPath, send, matchId)` (`cli/autopilot.ts:498-600`) and `sendControlRpc` (`:607`) into `cli/control-rpc.ts`, exported. Keep the `Bun.connect` + `LineBuffer` + `encodeFrame` (`src/protocol.ts`) shape intact; no behavior change.
- Refactor `cli/autopilot.ts` to import from the new module (delete the local copies). `resolveSockPath` continues to come from `src/db`.
- Provide a small `queryCollection(sockPath, collection, filter?)` convenience wrapping a single `query` frame round-trip (returns decoded rows), since dispatch needs read-then-exit semantics, not a subscription.

### Investigation targets

**Required** (read before coding):
- cli/autopilot.ts:498-610 — `roundTrip` / `sendControlRpc` and how it frames a `query`/`rpc` and matches by `id`.
- src/protocol.ts — `encodeFrame` / `LineBuffer` / frame shapes the helper uses.
- cli/board.ts / cli/await.ts — how other one-shot reads decode rows (confirm `subscribeCollection` is subscribe-only and unsuitable).

**Optional** (reference as needed):
- src/readiness-client.ts — `subscribeCollection` (the loop to AVOID), for contrast.

### Risks

- The lift must be behavior-preserving for `cli/autopilot.ts` — its existing tests must stay green. Keep the function signatures identical.

### Test notes

Cover `queryCollection` against a fake/echo socket (one-shot read returns decoded rows then closes); confirm `cli/autopilot.ts` still passes its suite after the refactor.

## Acceptance

- [ ] `cli/control-rpc.ts` exports `roundTrip` / `sendControlRpc` / a one-shot `queryCollection`.
- [ ] `cli/autopilot.ts` consumes the shared module with no behavior change; its tests pass.
- [ ] A one-shot read returns decoded rows and closes the connection (no lingering subscription).

## Done summary
Lifted the one-shot UDS roundTrip/sendControlRpc out of cli/autopilot.ts into a shared cli/control-rpc.ts and added a queryCollection read-then-exit helper. autopilot consumes the shared module with no behavior change; new tests cover queryCollection over a real UDS echo server.
## Evidence
