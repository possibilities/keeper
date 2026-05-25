## Description

**Size:** M
**Files:** src/readiness-client.ts (new), scripts/board.ts, test/board.test.ts

### Approach

Lift the three-collection subscribe + computeReadiness stack out of `scripts/board.ts:340-1009` into a reusable `src/readiness-client.ts` helper. After extraction, `board.ts` becomes a thin renderer: it owns sidecar writes, the per-frame `AnnotatedInvocation` index (board-specific UX), the `lastBody` byte-compare, and the rendered body — but NOT the connection, polling, coalesce, projection, or readiness computation.

**Helper API (committed shape):**

```ts
// src/readiness-client.ts
export interface ReadinessClientSnapshot {
  epics: Epic[];
  jobs: Map<string, Job>;
  subagentInvocations: SubagentInvocation[];   // flat — read from state.rows, NOT byId.values()
  readiness: ReadinessSnapshot;                 // from src/readiness
}

export interface SubscribeOptions {
  sockPath: string;
  idPrefix: string;                             // subscription IDs become `<prefix>-{epics,jobs,subagent-invocations}`
  onSnapshot: (snap: ReadinessClientSnapshot) => void;
  onLifecycle?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface ReadinessClientHandle {
  dispose(): void;                              // idempotent
}

export function subscribeReadiness(opts: SubscribeOptions): ReadinessClientHandle;
export function projectRows<T>(state: { rows: readonly unknown[] }): T[];
```

**Lifecycle contract (mirrors board today; fixes autopilot's missing reset):**
- All-three-strict first-paint gate: no `onSnapshot` fires until epics + jobs + subagent_invocations have each produced their first `result`.
- Capped-backoff reconnect (250 ms → 5000 ms doubling), post-disconnect re-handshake.
- Steady-poll backstop (500 ms) refetches all three collections each tick.
- Per-collection coalescing (`queryInFlight` / `refetchDirty`).
- On teardown: reset `state.rows`, `state.byId`, `state.order`, AND `gotResult = false` for all three (board's `scripts/board.ts:924-941` has this right; autopilot's current `teardownConnection` is missing the `gotResult` reset — the helper centralizes the correct behavior for both callers).
- `dispose()` is idempotent: pre-first-paint bails clean (no callback fires); during reconnect backoff cancels the pending timer and marks `shuttingDown`; called twice is a no-op.
- `subagentInvocations` is delivered as a flat `SubagentInvocation[]` (read from `state.rows`, NOT `byId.values()`) so predicate 6 sees every re-entrant sub-agent on a shared `job_id`.
- `onSnapshot` exceptions are NOT swallowed — propagate (matches keeper's "no in-process self-heal" stance and matches today's `emitFrameIfChanged`, which has no try/catch).
- SIGINT remains the CALLER's concern; the helper exposes `dispose()` and the caller wires its own signal handler (so board's and autopilot's SIGINT-prints stay per-script).

**`projectRows` migrates** from `scripts/board.ts:321-338` to `src/readiness-client.ts` (co-located with the helper's `CollectionState` shape). `test/board.test.ts` retargets its `projectRows` import to `../src/readiness-client` and the two-running-subagents-on-one-job_id regression (`test/board.test.ts:113-203`) moves with it. Renaming `test/board.test.ts` → `test/readiness-client.test.ts` is OPTIONAL; alternatively split into two files. Decide during implementation, but the regression test MUST land wherever `projectRows`'s import path now points.

**Board refactor:** replace `scripts/board.ts:340-389` (three-collection setup) and `scripts/board.ts:943-1009` (connect/poll plumbing) with a single `subscribeReadiness({ sockPath, idPrefix: "board", onSnapshot: emitFrameIfChanged, onLifecycle: emitLifecycle })` call. `emitFrameIfChanged` now takes the snapshot as input rather than reading globals (its body shrinks: drop the all-three-gate, drop the typed-cast block, drop the `computeReadiness` call; keep the per-frame `lastSubagentIndex` build + `lastBody` byte-compare + sidecar writes + render). Subscription IDs flip from board's current `epics-frames` / `jobs-frames` / `subagent-invocations-frames` to `board-epics` / `board-jobs` / `board-subagent-invocations` under the `idPrefix` contract — acceptable churn (server doesn't enforce uniqueness; debug-log shape only).

### Investigation targets

**Required** (read before coding):
- `scripts/board.ts:266-299` — `CollectionState` interface + the load-bearing docstring on `rows` (why it's used instead of `byId.values()` for `subagent_invocations`).
- `scripts/board.ts:321-338` — `projectRows` to migrate.
- `scripts/board.ts:340-389` — three-collection setup with current IDs.
- `scripts/board.ts:749-818` — `emitFrameIfChanged`: identify which lines are board-specific (sidecar, subagent index, lastBody) vs lifted to helper (all-three-gate, typed cast, computeReadiness call).
- `scripts/board.ts:870-922` — `handleFrame` (result/patch/meta/error routing).
- `scripts/board.ts:924-941` — `teardownConnection` reference (has the correct `gotResult = false` reset).
- `scripts/board.ts:943-1009` — `connectOnce` / `connectWithRetry` / `pollAll`.
- `test/board.test.ts:113-203` — the `projectRows` regression that MUST keep passing post-extraction.
- `src/protocol.ts:287` `encodeFrame` and `:374` `LineBuffer` — wire primitives the helper consumes (do not re-implement).
- `src/db.ts` `resolveSockPath` — the CALLER still resolves; the helper accepts `sockPath` as input.

**Optional** (reference as needed):
- `scripts/autopilot.ts:414-427` — autopilot's current `teardownConnection` (missing `gotResult = false`); confirms which version the helper inherits.
- `scripts/git.ts:267-301` — single-collection subscribe; reference only. Not in scope to migrate.

### Risks

- **Hidden coupling.** A board.ts field accidentally relied on that the helper's snapshot doesn't expose. Mitigation: `bun test test/board.test.ts` (especially the `projectRows` regression) + visual smoke-test of `bun scripts/board.ts` against a running keeperd, verifying byte-identical frames pre/post.
- **Subscription-ID naming drift.** `epics-frames` → `board-epics` etc. is observable in server-side debug logs only. No behavior or wire-protocol impact. Acceptable.
- **Worker-contract drift.** Helper is library code, not a Worker thread — no `isMainThread` guard, no `{ kind }`/`{ type }` message protocol, no LaunchAgent restart. CLAUDE.md's `## Worker contract` governs keeperd workers, not scripts/clients. Confirmed scope.

### Test notes

- `test/board.test.ts` (or its renamed successor) covers the load-bearing two-running-subagents-on-one-job_id regression — MUST stay green post-extraction.
- A new `test/readiness-client.test.ts` testing the subscribe loop end-to-end (mocked `Bun.connect`) is **nice-to-clarify only** — no precedent for a subscribe-loop unit test exists in `test/`. Skip in this task if mocking the socket adds substantial complexity; visual smoke-test against keeperd is sufficient proof for the lifecycle.
- **Open question (defer to implementer):** Should `test/board.test.ts` be renamed to `test/readiness-client.test.ts` post-migration of `projectRows`, or split into two test files? Either is defensible; pick the one that produces the cleaner diff.

## Acceptance

- [ ] `src/readiness-client.ts` exists and exports `subscribeReadiness(opts) → ReadinessClientHandle`, `ReadinessClientSnapshot`, `ReadinessClientHandle`, `SubscribeOptions`, and `projectRows<T>(state)`. API surface matches the contract above (no extra parameters that only one consumer needs; no exposed `byId` / `CollectionState`).
- [ ] `scripts/board.ts:340-389` and `:943-1009` collapse into a single `subscribeReadiness(...)` call; `emitFrameIfChanged` is invoked as the helper's `onSnapshot` callback and reads its inputs from the snapshot argument (not module-level state).
- [ ] `projectRows` is no longer exported from `scripts/board.ts`; `test/board.test.ts` (or successor) imports it from `../src/readiness-client`.
- [ ] The two-running-subagents-on-one-job_id regression test still asserts the same invariant (predicate 6 sees both running sub-agents) and passes.
- [ ] `bun scripts/board.ts` against a running keeperd produces visually identical output to pre-change (same `---` frames, same epic blocks, same `~~~` dividers, same readiness pills).
- [ ] `dispose()` called twice produces no errors; verified via SIGINT smoke-test.
- [ ] `bun test` passes.

## Done summary

## Evidence
