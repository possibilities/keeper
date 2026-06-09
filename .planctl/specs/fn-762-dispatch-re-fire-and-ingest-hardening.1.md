## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/daemon.ts, test/autopilot-worker.test.ts, CLAUDE.md, README.md, docs/exec-backend.md

### Approach

Three coupled changes to the dispatch confirm lifecycle (cluster A of the epic):

A1 — headroom: `REDISPATCH_COOLDOWN_S` (src/autopilot-worker.ts:190) 120 → 200,
with the comment rewritten from "aligned to PENDING_DISPATCH_TTL_MS" to "strictly >
PENDING_DISPATCH_TTL_MS/1000 (120) + PENDING_DISPATCH_SWEEP granularity (60)".
`FINALIZER_GUARD_S = REDISPATCH_COOLDOWN_S` (:212) tracks automatically — update its
stale 120s doc too. Verify the `ceilingMs (60s) < TTL (120s) < cooldown (200s)`
ordering note at :1462 stays true. Add a ONE-TIME fresh cooldown stamp when
confirmRunning resolves `indoubt` (:1451-1475): re-stamp at resolution only — never
compounding across cycles (the openclaw#23516 perpetual-suppression trap; the next
cycle's dispatch path re-stamps normally if it actually re-dispatches).

A2 — abort split: replace the `"aborted"` member of `ConfirmOutcome` (:956) with
`"aborted-prelaunch"` and `"aborted-postlaunch"` so the compiler forces every
comparison site to be visited. Pre-launch returns: :1391 (ack reject), :1396 (ack
{ok:false}), :1400 (shutdown-before-launch). Post-launch returns: :1420, :1435,
:1448 (mid-poll aborts after launch fired). The clear arm in runReconcileCycle
(:1567-1577) clears cooldown AND finalizer guard only on `failed ||
aborted-prelaunch`; `aborted-postlaunch` keeps both stamps (the launch fired — the
pause-reap projection may lag behind the ghost). Keep cooldown and finalizer-guard
lifecycles in lockstep (fn-742 parity — :419-447 vs :235-260 are mirrored pairs).

A3 — ack ordering: in handleDispatchedMint (src/daemon.ts:3302-3363), reply the ack
immediately after `insertEvent.run` succeeds (`ok=true` reflects INSERT durability
only — the :3340-3342 comment already states that contract), then run
`wakePending=true; pumpWakes()` AFTER the reply in its own guarded block: a pump
throw is logged via the existing error path but can neither flip the already-sent
ack nor escape the handler. Outbox ordering is UNCHANGED — confirmRunning still
awaits the ack before launch; only ack timing moves ahead of the drain.

UNIT TRAP: cooldown stamps and `deps.now()` are unit-SECONDS; ceilingMs /
pollIntervalMs / every `*_TTL_MS` are ms. They coexist inside confirmRunning — keep
the domains separate (see :185-188, :411-417).

Docs in the same commit: CLAUDE.md Autopilot fn-735 paragraph (value, strictly->,
pre-launch-only clear, indoubt re-stamp); README ~1782/~1962 ack-timing prose +
~2000 cooldown value; docs/exec-backend.md ~140-143 one-liner.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:1530-1604 — runReconcileCycle stamp (:1538) + clear arm (:1567-1577)
- src/autopilot-worker.ts:1380-1475 — confirmRunning: the five aborted returns + indoubt resolution
- src/autopilot-worker.ts:185-260, 411-447 — cooldown + finalizer-guard mirrored pairs, unit docs
- src/daemon.ts:3302-3363 — handleDispatchedMint try/catch shape
- test/autopilot-worker.test.ts:230-310 (makeFakeDeps), :792 (indoubt keeps stamp), :833 (failed clears), :981 (finalizer guard), :1432-1526 (confirmRunning direct)

### Risks

- Clearing on aborted-postlaunch reopens the fn-735 pause→unpause double-dispatch;
  keeping pre-launch stamps reopens stuck-suppression (failedKeys owns stickiness —
  pre-launch clears so retry_dispatch works without waiting out the window).
- Touching the cooldown pair without the finalizer-guard pair reopens fn-742.

### Test notes

Extend makeFakeDeps shapes: (a) post-launch abort — flip the AbortController AFTER
`launch` resolves, during the poll loop → outcome aborted-postlaunch, stamp KEPT;
(b) pre-launch abort (ack {ok:false} / never-resolving ack + abort) → stamp cleared;
(c) indoubt → exactly one fresh stamp at resolution (assert timestamp moved once);
(d) ack replies even when a queued pump would take >10s (inject a slow fold);
(e) existing :792/:833/:981 pins stay green with the renamed outcomes.

## Acceptance

- [ ] ConfirmOutcome has no bare "aborted"; clear arm fires only on failed || aborted-prelaunch; post-launch abort + indoubt keep/refresh the stamp (tests pin all three)
- [ ] REDISPATCH_COOLDOWN_S=200 with the strictly-greater rationale; finalizer guard tracks; unit-seconds discipline intact
- [ ] ack replies right after the committed INSERT; pump runs after, independently guarded (test: slow pump cannot push ack past the 10s ceiling)
- [ ] CLAUDE.md/README/exec-backend.md passages updated; full bun test green

## Done summary

## Evidence
