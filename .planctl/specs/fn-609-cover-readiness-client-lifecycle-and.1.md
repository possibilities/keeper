## Description

Bundles two audit findings against `src/readiness-client.ts` from the
fn-608 close.

**F7 — fatal error frame silently swallowed.** Pre-refactor
`scripts/board.ts` (commit `212be34^:870`) called `process.exit(1)`
when a terminal `error` frame arrived (the `bad_frame` /
`unknown_collection` branch where no collection had `gotResult`). The
extraction at `src/readiness-client.ts:310-332` emits the error via
`onLifecycle` but never propagates an exit, and neither caller's
`emitLifecycle` (`scripts/board.ts:645-662`,
`scripts/autopilot.ts:377-391`) reinstates it. A future `bad_frame`
hangs the CLI silently with no exit code.

**F8 — no unit test for `subscribeReadiness` lifecycle.** The helper
bundles the load-bearing first-paint all-three-strict gate, per-collection
coalesce (`queryInFlight` + `refetchDirty`), capped-backoff reconnect
(250 ms → 5000 ms), and idempotent `dispose()`. The only existing test
(`test/board.test.ts`) covers `projectRows` only.

Bundled in one task because the lifecycle test naturally covers the new
onFatal contract and both findings touch the same module.

## Acceptance

- [ ] `SubscribeOptions` accepts optional `onFatal?: (err: { code: string; rev?: number; message: string }) => void`. When omitted, the helper defaults to `process.exit(1)` on a terminal error frame (matching pre-extraction behavior).
- [ ] `subscribeReadiness` invokes `onFatal` (or the default) when an `error` frame arrives AND no collection has produced a `result` yet — same gating as the existing check at `src/readiness-client.ts:321-325`.
- [ ] `scripts/board.ts` and `scripts/autopilot.ts` either pass a custom `onFatal` or rely on the default; behavior preserved.
- [ ] New `test/readiness-client.test.ts` covers (driven by an in-memory mock socket — parameterize the `Bun.connect` factory or accept a socket-factory option for test injection): (a) first-paint gate — `onSnapshot` does not fire until all three collections produce a `result`; (b) per-collection coalesce — a refetch fired while `queryInFlight` sets `refetchDirty` and a single follow-up query goes out; (c) idempotent `dispose()` — second call is a no-op, no callback fires; (d) terminal `error` frame with no `gotResult` invokes `onFatal` with the error payload.

## Done summary

## Evidence
