## Description

**Size:** M
**Files:** src/reducer.ts, src/db.ts, keeper/api.py, src/collections.ts (descriptor only if the counter must be wire-visible), test/reducer-projections.test.ts, test/refold-equivalence.test.ts, README.md, CLAUDE.md

### Approach

Extend `foldDispatchExpired` to fold a per-(verb,id) consecutive-DispatchExpired-without-bind
counter. The counter must persist across expires (today the fold DELETEs the pending_dispatches
row at reducer.ts:3560) and reset to 0 on a successful bind. Pick the mechanism that folds
DETERMINISTICALLY from the event stream — either carry the count on the pending_dispatches row
(don't delete / re-create with the incremented count) or a small dedicated column; no wall-clock.
At K=3, mint a sticky failure via the EXISTING `foldDispatchFailed` UPSERT with reason="never-bound"
(non-empty, satisfies the extractor). Reset the counter in the SessionStart discharge-on-bind gate
(reducer.ts:6326-6335, the fn-832 NULL->non-NULL plan_verb transition — same guard as the existing
pending_dispatches DELETE). REUSE end-to-end: the never-bound DispatchFailed row auto-suppresses
re-dispatch via failedKeys (autopilot-worker.ts:920) and is cleared by retry_dispatch->DispatchCleared
(daemon.ts:1860) — confirm both need no change, and that the clear path also zeroes the counter.
Schema: v75->v76 via addColumnIfMissing (db.ts:1184) + the fresh-DB CREATE + SUPPORTED_SCHEMA_VERSIONS
76 + the doc-comment line in keeper/api.py, ALL in one commit. K is a tunable constant (3; 2 = more aggressive).

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:3555-3564 foldDispatchExpired; :3379-3415 foldDispatchFailed; :6207-6335 discharge-on-bind gate; :3303-3369 extract*Payload no-throw/null pattern
- src/db.ts:50 SCHEMA_VERSION=75; :810-844 CREATE_DISPATCH_FAILURES/PENDING_DISPATCHES; :1184 addColumnIfMissing; :2918-2926 re-fold wipe list; :3506-3528 migration ladder + doc-comment
- keeper/api.py:312-316 SUPPORTED_SCHEMA_VERSIONS convention
- src/autopilot-worker.ts:920-922 failedKeys; src/daemon.ts:1860-1889 retry_dispatch->DispatchCleared

### Risks

- Re-fold determinism: bump/reset MUST come purely from events (DispatchExpired + the bind transition), never wall-clock/env — else refold-equivalence breaks.
- Never throw in the fold (preserve the boot-drain-race no-op where SessionStart already discharged).
- Counter persistence vs the pending_dispatches DELETE — be explicit about where the count lives.
- "bound-then-died" must NOT trip this (bind reset handles it; that death is the exit-watcher's path, not this).

### Test notes

- K-th consecutive DispatchExpired-without-bind mints DispatchFailed("never-bound"); a bind between expires resets to 0 (no mint).
- malformed/missing payload -> no-op, cursor STILL advances, no throw.
- refold-equivalence byte-identical with a fixture exercising the counter; schema-version test green (76 in db.ts + api.py).
- `bun run test:full`.

## Acceptance

- [ ] per-(verb,id) consecutive-no-bind counter folded deterministically; mints sticky DispatchFailed("never-bound") at K=3; bind resets to 0; failedKeys suppression + retry clear unchanged and verified (incl. clearing the counter); SCHEMA_VERSION 75->76 + api.py 76 same commit; re-fold byte-identical; test:full green

## Done summary

## Evidence
