## Description

**Size:** M
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts, README.md, CLAUDE.md

### Approach

Add an in-process per-`verb::id` re-dispatch cooldown to the autopilot worker — a `Map<DispatchKey, number>` (dispatch timestamp, unix SECONDS) held on `ReconcileState`, same shape/lifecycle as the existing `inFlight` set and the `server-worker.ts` `lastSent` reaper. It bridges the fold-lag gap the projection-backed arms can't see: `inFlight` is released in the `finally` at autopilot-worker.ts:1292 the moment `confirmRunning` resolves, but `liveTabKeys` (from the `pending_dispatches` projection) may not have folded yet — so the next cycle re-dispatches the same key. The cooldown holds the key suppressed for `REDISPATCH_COOLDOWN_S` (=120, aligned to `PENDING_DISPATCH_TTL_MS`) until the durable projection arms catch up.

**Key construction:** always via `dispatchKey(verb, id)` (autopilot-worker.ts:312) — never re-concatenate `${verb}::${id}`.

**Stamp:** in `runReconcileCycle`, at the same point as `state.inFlight.add(plan.key)` (≈line 1256), BEFORE the `confirmRunning` await — so it covers BOTH `ok` AND `indoubt` outcomes. The slow cold-boot `indoubt` case (worker live, `pending_dispatches` real, `jobs` row not yet bound, `Dispatched` fold still lagging) IS the headline bug; gating the stamp on `outcome==="ok"` would leave exactly those slow launches re-dispatchable. On a definitive launch failure (`launch.ok===false` → `DispatchFailed`) and abort-before-launch, DELETE the cooldown entry so `failedKeys` owns stickiness and the human's `retry_dispatch` re-dispatches without reaching worker memory.

**Gate:** read the cooldown inside the pure `reconcile` via `state` (like `inFlight`) — NEVER mutate it inside `reconcile`; purity is sacred (~30 unit tests). Add the gate to BOTH dispatch sites: the task suppression chain (≈950-996, alongside the `inFlight` arm) AND the close-row `okToPlan` boolean (≈1010-1046). Insert it ABOVE the fn-728 approve-exempt budget gate and DO NOT make it approve-exempt — the cooldown must cover approve too (that is the fn-734 case this supersedes).

**Sweep:** prune entries older than the cooldown window each cycle (mirror `reapStuckPending`/`STUCK_PENDING_TTL_MS` at server-worker.ts:1897-1918), wrapped so a sweep error can't crash the worker (no self-heal).

**Unit discipline:** `reconcile`'s `now` is unix SECONDS (`deps.now` = `Math.floor(Date.now()/1000)`, autopilot-worker.ts:1802). Keep the cooldown entirely in seconds; define `REDISPATCH_COOLDOWN_S` in seconds. Do NOT mix with the ms-valued `*_TTL_MS` constants (the documented unit trap — a 1000x bug).

**In-memory ONLY:** never written to the event log, projections, reducer, or RPC surface; boots empty on restart (safe — autopilot boots paused, the first cycle rebuilds suppression from the live projection).

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:871-1050 — `reconcile`, the pure decision fn + BOTH dispatch sites (task chain 950-996, close-row 1010-1046)
- src/autopilot-worker.ts:1217-1295 — `runReconcileCycle`: `inFlight.add` 1256 (stamp site), outcome handling (ok 1273 / indoubt 1201), `finally` release 1292
- src/autopilot-worker.ts:454-464 — `ReconcileState` shape to extend; 311-313 `dispatchKey`/`Verb`
- src/autopilot-worker.ts:985-993,1026-1031 — fn-728 approve-exempt gate/decrement symmetry warning (cooldown goes ABOVE it, not exempt)
- src/server-worker.ts:1897-1918 — `reapStuckPending` + `STUCK_PENDING_TTL_MS` Map-reaper to mirror
- test/autopilot-worker.test.ts:135,153,209 — `makeSnapshot`/`makeState`/`makeFakeDeps` fixtures; per-arm dedup tests (inFlight 578, failedKeys 607, liveTabKeys 615/632, pendingDispatches 657)

**Optional** (reference as needed):
- src/rpc-handlers.ts:568-686 — `retry_dispatch` → `DispatchCleared` (clears `failedKeys`, NOT worker memory)
- src/daemon.ts:264,318-336 — `PENDING_DISPATCH_TTL_MS` + the ms<->s conversion pattern

### Risks

- **Unit trap:** seconds vs ms = a 1000x cooldown bug. Keep everything in seconds; one named constant.
- **indoubt outcome:** the stamp MUST cover indoubt (stamp before the await), or the slow-cold-boot bug survives.
- **Two dispatch sites:** miss the close-row site and close rows still DUP-DISPATCH.
- **Approve coverage:** the gate must NOT be approve-exempt, or approve DUP-DISPATCH (the fn-734 case) is left unfixed.
- **Re-dispatch latency tradeoff (accepted):** an early-but-incomplete worker waits out the TTL before `work::id` re-dispatches (no active early-release this epic).
- **Wall-clock jumps:** benign self-healing over/under-suppression for a guard like this; monotonic clock deferred.
- **Map leak:** must sweep, wrapped (a throw would bounce the daemon).

### Test notes

- Add per-verb cooldown suppression tests in the `reconcile dedup` style: dispatch `verb::id`, advance `now` < cooldown -> suppressed; advance `now` >= cooldown -> re-dispatchable. Cover work, close, AND approve (approve proves the fn-734 supersession).
- Test the stamp covers indoubt: via `makeFakeDeps`, an `indoubt` `confirmRunning` outcome still leaves the cooldown set.
- Test failure clears the cooldown: a `launch.ok===false` leaves the key re-dispatchable.
- Test the sweep prunes expired entries (no unbounded growth).
- Keep `reconcile` pure: cooldown read from `state`, mutated only in the cycle glue; existing reconcile tests stay green.

## Acceptance

- [ ] In-memory `Map`-based per-`verb::id` cooldown on `ReconcileState`, keyed via `dispatchKey`, stamped at dispatch (before the confirm await; covers ok+indoubt), cleared on definitive launch failure/abort.
- [ ] Gate added to BOTH dispatch sites (task chain + close-row `okToPlan`), above the fn-728 budget gate, NOT approve-exempt — covers work/close/approve.
- [ ] `REDISPATCH_COOLDOWN_S` defined as a named, documented constant in seconds (=120), unit-consistent with `reconcile`'s seconds-`now`.
- [ ] Cooldown swept each cycle (mirror `reapStuckPending`), wrapped to never throw.
- [ ] `reconcile` stays pure — cooldown read via `state`, never mutated inside `reconcile`; existing reconcile unit tests still pass.
- [ ] Nothing written to event log / projections / reducer / RPC surface; cooldown boots empty.
- [ ] New tests: per-verb cooldown suppression (incl. approve), indoubt-keeps-stamp, failure-clears, sweep-prunes.
- [ ] README.md `## Architecture` + CLAUDE.md `## Autopilot` updated: cooldown described as the fold-lag-immune suppression arm, supersedes fn-734; full `bun test` green.
- [ ] DEPLOY: after merge, restart keeperd via `launchctl kickstart -k gui/$(id -u)/arthack.keeperd` (the running daemon won't pick up the code otherwise); autopilot boots paused — confirm no dup-dispatch on the next unpause.

## Done summary

## Evidence
