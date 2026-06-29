## Description

**Size:** M
**Files:** src/subagent-invocations.ts, src/reducer.ts, src/readiness.ts, src/readiness-client.ts, test/reducer-lifecycle.test.ts, test/board.test.ts, test/readiness.test.ts, test/subagent-invocations.test.ts, README.md

### Approach

Introduce ONE canonical "open turn" in-flight definition — `duration_ms IS NULL AND status IN ('running','ok')` — and route all five liveness sites through it, replacing the scattered `status='running'` checks. SQL and TS cannot share a literal, so define a single canonical status-set constant (the source of truth for membership) and add a parity test asserting every site agrees on it; this is the anti-drift mechanism (drift between consumers is the exact bug being fixed).

Factor the reducer-side anchor-with-freshness helper `findFreshInFlightSubagentAnchor(db, jobId, maxGapSec, eventTs)` in src/subagent-invocations.ts, right after `findOpenTurnForStop` (mirror its JSDoc + re-fold-determinism rationale). Both reducer guards call it. Re-base the freshness anchor from the frozen SubagentStart spawn `ts` to last-activity `updated_at`. The readiness layer widens its in-memory filter only — NO time/staleness bound (the deliberate asymmetry: a readiness bound would re-dispatch a slow-but-alive sub, since a long Bash/build freezes `updated_at` by emitting no SubagentTurn). SILENT_STREAM_CUT stays byte-for-byte untouched.

Resolved sub-decisions (bake in, do not re-litigate):
- **Helper contract:** pick the freshest survivor (`ORDER BY updated_at DESC` PLUS a deterministic secondary sort — e.g. `turn_seq DESC, agent_id` — so `updated_at` ties never make the anchor pick non-deterministic; `updated_at` ties are MORE likely than `ts` ties because the sweep/bulk folds stamp identical `updated_at`). Treat `updated_at IS NULL OR updated_at <= 0` as uncomputable → BLOCKING (preserve the current Stop swallow at reducer.ts:7742). Release only when even the freshest survivor's age (`event.ts - updated_at`) STRICTLY exceeds `maxGapSec`. Spell this fresh-or-uncomputable contract inside the helper, not at the call sites.
- **ApiError/RateLimited guard:** lift the liveness decision to the helper, but KEEP stamping `last_api_error_at` / `last_api_error_kind` UNCONDITIONALLY — only the `state` CASE branch is gated on the anchor. Preserve "stamp the pair always, suppress the state flip only". This guard currently has no freshness bound and no same-name collapse — the helper adds both.
- **Sweep:** widen `sweepRunningSubagentsToUnknown` to the FULL predicate including `duration_ms IS NULL` — never the bare status set, or a finished `ok` row (non-null `duration_ms`) on a terminal job gets clobbered to `unknown` (data corruption).
- **Out of scope:** `findOpenRunningInGroup` (src/subagent-invocations.ts:194-215) is the supersession scan, not liveness — leave it on `status='running'`. The readiness visibility staleness anchor `allRunningSubagentsAreStale` (`now - inv.ts`, readiness.ts:2059) stays on `ts` — cosmetic-only, the request re-bases only the reducer guards.

### Investigation targets

**Required** (read before coding):
- src/subagent-invocations.ts:143-158 — `findOpenTurnForStop`, the precedent to mirror (`duration_ms IS NULL` alone; fn-480 comment explains why `status='ok'` must not also gate)
- src/reducer.ts:118 — `MAX_STOP_YIELD_GAP_SEC = 120` (compile-time const, no clock/config read — keep it that way)
- src/reducer.ts:7722-7762 — Stop-guard `subRunning` query (swap predicate to the helper + re-base anchor `ts`→`updated_at`)
- src/reducer.ts:7864-7899 — ApiError/RateLimited guard (inline `CASE … EXISTS(status='running')`; add freshness + collapse via the helper, preserve unconditional pair stamp)
- src/reducer.ts:4872-4885 — `sweepRunningSubagentsToUnknown` (widen WHERE to the full predicate; called from SessionEnd 7785 + Killed 7858)
- src/readiness.ts:545-559 — predicate-6 `subRunningByJobId` index (widen `inv.status !== "running"` filter; do NOT plumb `now` in — it would break the `now=-Infinity` byte-identity contract)
- src/readiness.ts:283-319 — `SUBAGENT_STALENESS_SEC` / `RunningReason` narrative (the "mirrors `MAX_STOP_YIELD_GAP_SEC`" claim is now severed)
- src/readiness-client.ts:538-572 — `collapseSubagentsByName` (widen the `status==="running"` gate at 558/562)
- test/reducer-lifecycle.test.ts:5910-5971 (fn-593.3 fixture), 6111-6175 (bounded-guard fresh/stale/boundary + 6168 sentinel), 6069-6097 (re-fold determinism idiom)
- test/board.test.ts:188-300 (collapse stuck-count tests @209/@252/@290)

**Optional** (reference as needed):
- src/db.ts:761-781 — subagent_invocations schema + `idx_subagent_invocations_job` (do NOT add a `(status,duration_ms)` index — every query is job-scoped, per-job rows are tiny)
- test/readiness.test.ts:2421-2505 — predicate-6 coverage (uses `runWithNow`)
- test/subagent-invocations.test.ts:681-725 — `findOpenTurnForStop` unit-coverage style to mirror for the new helper (this file is a FROZEN golden-fixture parity test)

### Risks

- `updated_at` ties → non-deterministic anchor pick → re-fold non-determinism (violates the sacred `jobs`-projection invariant). The deterministic secondary sort is mandatory, not optional.
- Sweep dropping the `duration_ms IS NULL` clause → finished `ok` rows clobbered to `unknown` (silent data corruption).
- ApiError refactor regressing "stamp pair always, suppress flip only" — the api-error annotation must stamp even while the state flip is suppressed.
- SQL/TS definition drift — the single status-set constant + the parity test are the guard against re-introducing the very bug being fixed.

### Test notes

Reconcile (semantics flip under the new predicate):
- reducer-lifecycle.test.ts:5910-5971 (fn-593.3): set `duration_ms` non-NULL on the "finished" turn_seq=2 row — preserves the `stopped` assertion and the fixture's stated intent.
- reducer-lifecycle.test.ts:6168 sentinel: hand-insert `updated_at=0` (the guard now reads `updated_at`, not `ts`) so the "uncomputable age" branch is still exercised.
- board.test.ts stuck-counts: @209 `1→3`, @252 `1→3`, @290 `0→1`.

Add:
- Stop-guard "activity refreshes `updated_at` and re-arms the 120s window" (the whole point of the anchor re-base).
- background-hold: an open-`ok` sub keeps the parent `working` across a Stop; after SubagentStop sets `duration_ms`, the next Stop stops the job.
- ApiError "stale (>120s) in-flight sub flips state" + "collapse-masked orphan does not suppress" (reducer-lifecycle.test.ts:6038 covers only the fresh-suppress case today).
- whitelist excludes `failed`/`unknown`/`superseded` (not counted in-flight).
- sweep closes a backgrounded orphan (`ok`+NULL) to `unknown`; never clobbers a finished `ok`.
- readiness counts open-`ok` as in-flight (no double-dispatch) with NO time bound.
- a parity test asserting all sites share the one status-set definition.
- re-fold determinism replay (idiom at 6069-6097) for the new predicate.

## Acceptance

- [ ] One canonical open-turn definition (`duration_ms IS NULL AND status IN ('running','ok')`) backs all five liveness sites; no liveness site spells a bare `status='running'` check anymore (supersession scan `findOpenRunningInGroup` excepted)
- [ ] `findFreshInFlightSubagentAnchor` lives next to `findOpenTurnForStop`; both reducer guards call it; it picks the freshest survivor with a deterministic tiebreak, treats uncomputable `updated_at` as blocking, releases only when the freshest survivor's age strictly exceeds 120s
- [ ] Stop-guard + ApiError guard re-based to `updated_at`; the ApiError guard still stamps `last_api_error_at`/`kind` unconditionally and gates only the `state` flip
- [ ] `sweepRunningSubagentsToUnknown` widened to the full predicate (`duration_ms IS NULL` retained); finished `ok` rows are never swept to `unknown`
- [ ] Readiness predicate-6 index + readiness-client collapse widened to open-turn; NO `now`/staleness bound added to readiness; the `now=-Infinity` byte-identity contract preserved
- [ ] SILENT_STREAM_CUT (`dropParentJobOnSilentStreamCut` + both trigger arms) byte-for-byte unchanged
- [ ] fn-593.3, 6168, and board.test.ts stuck-count fixtures reconciled; new tests (activity-re-arm, background-hold, ApiError stale-flip, ApiError orphan-ignored, whitelist-excludes, sweep-orphan-close, readiness-no-bound, parity, re-fold determinism) added and green
- [ ] `bun test` green; biome lint + `tsc --noEmit` clean
- [ ] Stale doc comments updated (reducer JSDocs for `MAX_STOP_YIELD_GAP_SEC` + sweep + Stop/ApiError inline; readiness `subRunningByJobId` comment + the severed `SUBAGENT_STALENESS_SEC` "mirrors" claim; README ~201/~3756 open-turn clarification)

## Done summary
Introduced one canonical open-turn predicate (duration_ms IS NULL AND status IN running|ok) via OPEN_TURN_STATUSES/isOpenTurnRow/findFreshInFlightSubagentAnchor in subagent-invocations.ts, and routed all five liveness sites through it: the Stop + ApiError reducer guards (now updated_at-anchored with same-name collapse, ApiError still stamps the pair unconditionally), the SessionEnd/Killed sweep, readiness predicate-6, and readiness-client collapse. Served duration_ms so readiness can distinguish an open ok (in flight) from a finished one; readiness stays deliberately unbounded. SILENT_STREAM_CUT untouched; full suite + lint + typecheck green.
## Evidence
