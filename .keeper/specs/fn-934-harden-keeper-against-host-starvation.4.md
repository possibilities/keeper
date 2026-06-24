## Description

**Size:** M
**Files:** src/reducer.ts, test/refold-equivalence.test.ts, CLAUDE.md

### Approach

`computeMonitors` (src/reducer.ts:7616, called from the Stop fold :6986) scans a
session's FULL event history on EVERY Stop (`SELECT background_task_id, tool_name
FROM events WHERE session_id=? AND background_task_id IS NOT NULL AND id<currentEventId`,
:7631) — an O(history) per-event cost, the next time-bomb. Bound the cost WITHOUT
changing the projected monitor set: a fixed ts/lookback window is WRONG (monitors are
long-lived; a window would drop an old monitor from `jobs.monitors` — a silent
projection change). Instead use an INCREMENTAL id-watermark memo — mirror fn-892's
`buildExplicitAttribHoist` per-`Database` memo that scans only `id > maxId` and
accumulates — so steady-state cost is bounded by the delta, not session history, and
the accumulated provenance set is byte-identical to the unbounded scan. The memo is a
PURE optimization, NEVER a fold input that changes output, and uses only the event's
`id`/`ts` (NEVER `Date.now()`/wall-clock — re-fold determinism is sacred; this is a
fold, so the serve-path `recencyBound`/`ResolvedFilter` is forbidden here).
`computeMonitors` must still never throw (returns '[]' on malformed). Add `computeMonitors`
to the CLAUDE.md O(history) invariant index.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:7616-7642 — `computeMonitors` + the O(history) scan; :6986 — the Stop-fold call site
- src/reducer.ts (the `buildExplicitAttribHoist` `id > maxId` WeakMap/per-Database memo from fn-892) — the model for an incremental id-watermark accumulator that stays a pure optimization
- test/refold-equivalence.test.ts — the byte-identical re-fold GATE (freshMemDb, two from-scratch re-folds); the determinism proof for the change
- src/collections.ts:54, :412 — why `recencyBound`/`ResolvedFilter` is serve-path-only (wall-clock) and MUST NOT be used in this fold

### Risks

- A lookback window changes the projection (drops old monitors) AND can differ between live-fold and re-fold — avoid; the memo must reproduce the unbounded monitor set exactly.
- The memo must never become a fold input that changes output (pure optimization only), or re-fold determinism breaks.
- Keep the `idx_events_background_task_id` index covering so the bounded scan stays index-backed.

### Test notes

Prove BOTH: (1) `jobs.monitors` projection IDENTICAL to the current unbounded scan
over a multi-monitor, long-session corpus (including a monitor launched far in the
past); (2) byte-identical from-scratch re-fold (extend/exercise test/refold-equivalence.test.ts).
No `Date.now()`/wall-clock/env/fs in the fold. `bun run test:full`.

## Acceptance

- [ ] `computeMonitors` per-event cost no longer scales with session history (incremental id-watermark memo, not a full-history scan).
- [ ] `jobs.monitors` is byte-identical to the prior unbounded projection (a long-lived monitor older than any window is NEVER dropped) — proven over a multi-monitor corpus.
- [ ] Byte-identical from-scratch re-fold holds (refold-equivalence); no `Date.now()`/wall-clock/serve-path recencyBound in the fold.
- [ ] `computeMonitors` added to the CLAUDE.md O(history) invariant index; `bun run test:full` green.

## Done summary
Bounded computeMonitors' O(history) Stop-fold provenance lookup with a per-Database incremental id-watermark WeakMap memo (mirrors fn-892), scanning only id > maxId and accumulating first-observed provenance per (session, task_id). jobs.monitors is byte-identical to the prior unbounded scan with no lookback window, proven over a long multi-monitor corpus + from-scratch re-fold.
## Evidence
