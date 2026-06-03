## Description

**Size:** M
**Files:** src/refold-progress.ts (new), src/view-shell.ts,
test/refold-progress.test.ts (new), test/view-shell.test.ts (new)

### Approach

Add `src/refold-progress.ts`: an injectable poller exposing
`{ poll(): { cursor: number; max: number } | null; close(): void }`. It
lazily opens ONE read-only connection via
`openDb(resolveDbPath(), { readonly: true, busyTimeoutMs: 100 })` on first
poll (wrapped in try/catch → null), then runs two naked autocommit SELECTs —
`SELECT last_event_id FROM reducer_state` and `SELECT MAX(id) AS m FROM events`
— returning `{cursor, max}` or null on any throw / missing row. Mirror
`src/wake-worker.ts:69-126` for the open/query/close shape.

In `src/view-shell.ts`, replace the per-lifecycle-tick spinner block
(`emitLifecycle`, ~408-423): on the first `emitLifecycle` call while
`frameCount===0 && event!=="connected"`, arm a single `setInterval(~125ms)`
if not already running. Each tick: advance `connectingSpinnerIdx`, call the
injected poller, and `pushFrame` the composed line. Compose
`⠹  re-folding event log  NN.N%  C / M` (thousands-grouped via
`toLocaleString`) when `cursor < max`; otherwise (null / `cursor>=max` /
`max` falsy) the plain `⠹  connecting to keeperd…`. Keep last-good
`{cursor,max}` as a floor across ticks; drop to plain after 3 consecutive
misses. Self-stop ONLY on `frameCount>0` (do NOT stop on `connected` — it
lands before the first frame paints, per `readiness-client.ts:800`); also
stop + close in the SIGINT `onDispose` (`view-shell.ts:430-444`). Inject the
poller via a new optional `ViewShellOptions` field defaulting to the real
`createRefoldProgressPoller()` so tests pass a fake. `db.close()` must be
idempotent (guard double-close across self-stop + SIGINT).

### Investigation targets

**Required** (read before coding):
- src/view-shell.ts:169 — `createViewShell` factory + `ViewShellOptions`
  (where the injected poller field lands; no top-level side effects)
- src/view-shell.ts:204-213 — `frameCount`/`lastBody` closure vars +
  `CONNECTING_SPINNER`/`connectingSpinnerIdx`
- src/view-shell.ts:357-371 — `emit()` is the SOLE `frameCount` incrementer
  (the spinner must use `pushFrame`, never `emit`)
- src/view-shell.ts:408-423 — the per-tick connecting-spinner block to REPLACE
- src/view-shell.ts:430-444 — SIGINT `installSigintHandler`/`onDispose`
  teardown seam
- src/wake-worker.ts:69-126 — canonical readonly + naked-autocommit SELECT +
  close-on-teardown pattern to mirror
- src/db.ts:5408-5426 — `openDb` readonly throws on missing file + the
  `busyTimeoutMs` option
- src/db.ts:69-75 — `resolveDbPath()` (honors `KEEPER_DB`; route through it
  for test sandboxing)
- src/readiness-client.ts:800 — `connected` emits BEFORE the first frame (why
  `connected` must not stop the interval)

**Optional** (reference as needed):
- test/readiness-client.test.ts:60-141, 461-485 — injected `connect` factory
  (MockSocket) + `globalThis.setTimeout` monkeypatch timer style (house
  pattern; no fake-timer dep)
- src/db.ts:1676 — `applyPragmas` (busy_timeout default 5000 — the value being
  overridden)

### Risks

- **Poll blocks the animation:** during the migration `BEGIN IMMEDIATE`
  (ALTER+rewind) window a readonly SELECT can block up to `busy_timeout`; the
  ≤100ms override + last-known floor keeps the ~125ms cadence honest. If even
  100ms causes visible jitter, switch the tick to a self-rescheduling
  `setTimeout` so polls can't pile up on one connection.
- **Interval leak → TUI won't exit:** Bun `setInterval` has no `.unref()`; the
  SIGINT teardown wiring is mandatory, not cosmetic. Missing the self-stop or
  the onDispose clear leaks the timer or the readonly fd.
- **Double spinner thrash:** the old `emitLifecycle` block must be fully
  removed, not run alongside the timer, or two braille indices fight.
- **Stale/garbage cursor:** never open with `immutable=1` against the live
  writer; clamp [0..1] and treat a non-monotonic cursor as a floor-holding
  reset.

### Test notes

- `test/refold-progress.test.ts`: point `KEEPER_DB` at a tmp DB; assert
  `{cursor,max}` read back; assert null on a missing-file open and on a forced
  query throw; assert idempotent `close()`.
- `test/view-shell.test.ts` (greenfield): inject a fake poller + monkeypatch
  `globalThis.setInterval`/`clearInterval` (house style); assert the timer
  arms while `frameCount===0`, composes the % line from the fake, self-stops +
  closes once `frameCount>0`, and the SIGINT path clears the interval and
  closes idempotently. Assert the plain-spinner fallback when the fake returns
  null and after 3 consecutive misses.

## Acceptance

- [ ] `src/refold-progress.ts` exposes an injectable `{poll, close}` poller:
  lazy readonly open via `openDb(resolveDbPath(), {readonly:true,
  busyTimeoutMs:100})`, two naked autocommit SELECTs, null on any throw /
  missing row, idempotent close.
- [ ] `createViewShell` accepts the poller via a new optional
  `ViewShellOptions` field defaulting to the real implementation; the old
  per-lifecycle-tick spinner block is removed.
- [ ] A `~125ms` interval animates the indicator and renders
  `⠹  re-folding event log  NN.N%  C / M` when `cursor<max`, plain
  `connecting to keeperd…` otherwise; no `NaN%`/`>100%`/fake-100% (guards for
  `max` falsy + `cursor>max`; 100% only on confirmed connection).
- [ ] Interval + connection torn down on both first-frame self-stop and
  SIGINT; no leaked timer (clean exit) and no leaked fd; double-close safe.
- [ ] `bun test test/refold-progress.test.ts test/view-shell.test.ts` passes.

## Done summary

## Evidence
