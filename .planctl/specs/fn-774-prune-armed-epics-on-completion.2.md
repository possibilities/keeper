## Description

**Size:** S
**Files:** src/daemon.ts, src/rpc-handlers.ts, test/daemon.test.ts, README.md

### Approach

In the main-side `set-epic-armed-request` handler (`src/daemon.ts:2167-2226`),
before appending an `EpicArmed` event for an `armed:true` request, read the
target epic's `status` from the writer DB; if the epic is PRESENT in the
`epics` projection AND `status='done'`, reject the request (return a failure
envelope) instead of appending. Leave two cases untouched: `armed:false`
(disarm must ALWAYS succeed) and a not-yet-folded epic (absent `epics` row →
still allowed — the documented "append unconditionally to dodge fold-lag"
rationale protects UNFOLDED epics, and a `done` epic is definitionally
folded, so this guard never rejects a legitimately-racing arm). The read
belongs daemon-side (writer-DB access); the worker-side async handler is
contractually forbidden a DB connection. Amend both docstrings
(`src/daemon.ts:2173-2180` and `src/rpc-handlers.ts:289-300`) to carve the
done-rejection out of the "no existence validation, append unconditionally"
note. Then update README.md's `keeper autopilot` CLI subsection: arming a
`done` epic is rejected.

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:2167-2226 — `set-epic-armed-request` handler, the unconditional-append site; docstring 2173-2180 to amend
- src/rpc-handlers.ts:289-312 — `setEpicArmedHandler` + its "NO existence validation" docstring to amend
- test/daemon.test.ts:2783 — existing arm/disarm fold round-trip test (the pattern to extend)
- src/epic-deps.ts:120 — `epicIsCompleted` = `status === "done"` (use this predicate / literal)

**Optional** (reference as needed):
- src/reducer.ts:4225-4240 — `foldEpicArmed` (what the rejected append would otherwise feed)
- README.md `keeper autopilot` CLI subsection (~853-877)

### Risks

- Reject ONLY for `armed:true`; never reject a disarm (`armed:false`) — you must always be able to disarm a stuck row.
- Reject ONLY when the epic is PRESENT and `done`; an absent `epics` row (not-yet-folded) must still be allowed, preserving fold-lag tolerance.
- The status read must use the daemon's writer DB connection, not be pushed into the worker-side handler.

### Test notes

- arm a `done` epic → rejected, no `EpicArmed` event appended, `armed_epics` stays empty
- arm an `open` epic → still appends + arms (unchanged behavior)
- arm a not-yet-folded epic (no `epics` row) → still allowed (no rejection — fold-lag tolerance)
- disarm a `done` epic → always allowed

## Acceptance

- [ ] `set-epic-armed-request` rejects an `armed:true` request when the target epic is present and `status='done'`; no `EpicArmed` event is appended
- [ ] `armed:false` is never rejected; arming a not-yet-folded epic (absent `epics` row) is still allowed
- [ ] the status read uses the writer DB in `daemon.ts`, not the worker-side handler
- [ ] `daemon.ts` + `rpc-handlers.ts` docstrings carve the done-rejection out of the "append unconditionally" note
- [ ] test/daemon.test.ts covers arm-done-rejected, arm-open-allowed, arm-unfolded-allowed, disarm-done-allowed
- [ ] README.md `keeper autopilot` CLI subsection notes arming a `done` epic is rejected

## Done summary

## Evidence
