## Overview

After fn-694 cut sidecar surfacing to single-digit ms, the dominant
remaining reality→surface latency tail is a `subagent_invocations` refetch
storm on the board: every fold nudges all ~21 live `keeper board`
subscribers, each synchronously refetches the ENTIRE subagent_invocations
set (~2005 rows / ~665KB), and the server answers all 21×665KB serially on
its single event loop — blocking 382-538ms per fold burst (diagnosed in
fn-694.3 with KEEPER_TRACE_SERVER=1). Because the loop is shared, this taxes
the jobs/git/usage sidecars too (the 360ms jobs outlier still seen
post-fn-694).

This epic lands the two cheap, safe, high-impact levers: (1) COALESCE the
server-side meta-nudge emission so a burst of folds collapses into fewer
refetch rounds across all subscribers; (2) SHRINK each refetch by
column-narrowing the subagent_invocations wire frame to the 7 columns
readiness + render actually use (~halves the dominant serialize cost,
wire+in-process, no schema bump). Both are gated by scripts/bench-latency.ts
before/after under matched multi-board load. None touches a fold —
re-fold determinism is not in play.

## Quick commands

- `bun scripts/bench-latency.ts --duration 30` — measure jobs+epics surfacing (run before/after; open several `keeper board` instances to reproduce the ~21-subscriber storm)
- `KEEPER_TRACE_SERVER=1` on the daemon, then a bench run — confirm the `poll-loop sleep overrun` clusters (382-538ms) shrink
- `bun test test/server-worker.test.ts test/board.test.ts test/readiness-client.test.ts` — the touched suites + the load-bearing predicate-6 / subagent-rows invariants

## Acceptance

- [ ] Server coalesces meta-nudge emission per subscription (≤1 meta per min-interval per sub) while patches stay immediate; a throttled-away nudge still converges (final membership state always emits)
- [ ] subagent_invocations wire frame narrowed to the safe-7 columns; EVERY descriptor consumer (wire render, predicate-6, in-process autopilot read) audited green; no schema/keeper-py change
- [ ] bench-latency board/jobs tail measurably reduced under matched multi-board load; the KEEPER_TRACE_SERVER sleep-overrun clusters shrink
- [ ] all existing tests green (esp. test/board.test.ts projectRows + collapseSubagentsByName ×N/stuck); docs touched where nudge/limit prose changed
- [ ] no fold-path change — re-fold determinism invariants untouched

## Early proof point

Task that proves the approach: `.2` (column-narrow). It's the safest,
most directly measurable lever (frame bytes ~halve) and is now load-bearing
since serialize dominates. If a consumer turns out to need a dropped column:
keep that one column and re-narrow to the minimal safe set, then reassess.

## References

- fn-694-reduce-tui-surface-latency, esp. task `.3` — the diagnosis that scoped this storm
- fn-2-keeper-uds-subscribe-server `.3` — diffTick / meta-pass origin
- scripts/bench-latency.ts — before/after harness (open multiple boards to reproduce the storm)
- practice-scout sources: server-side coalesce-before-fan-out (LWN edge/level-triggered), trailing debounce with maxWait, request single-flight (Discord/Redis thundering-herd), socket backpressure (Bun drain)

## Best practices

- **Coalesce before fan-out, gate meta only:** the throttle suppresses redundant membership nudges, NEVER patches (patches are the correctness-critical cell stream).
- **Never advance `lastTotal`/`lastToken` on a throttled-away nudge:** the membership delta must persist so the next eligible tick emits it — this is what guarantees convergence (no lost-final-update).
- **Throttle state lives on `SubState`, not `diffTick`-local:** `handleKick` and `pollLoop` both call `diffTick`, so a local clock would split across the two wake paths.
- **Column-narrow is "every `runQuery`/`selectByIds` consumer," not "wire-only":** the autopilot-worker reads `descriptor.columns` in-process; the safe-7 must satisfy wire render + predicate-6 + autopilot collapse. A dropped column read elsewhere fails silently (undefined → blank), so audit every reader.
- **Column projection beats pagination here:** row-filtering (status=running) or latest-per-job aggregates break render's ×N count / N-stuck annotations and superseded-orphan detection; paging fights the `job_id` wire-pk / `byId` diff. Narrow columns, keep all rows.

## Alternatives (deferred — revisit after remeasure)

- **Client-side min-interval refetch throttle** on `scheduleRefetchFor`: complementary, but there is NO 500ms steady-poll refetch backstop (`pollAll` is diagnosis-only post-fn-632.1), so it REQUIRES a `maxWait` trailing-edge flush or it strands stale board state, and must compose with the existing `queryInFlight`/`refetchDirty` coalescer without a lost-nudge gap. Defer until we see whether server-coalesce + narrow already erase the tail.
- **Query-seam shared-buffer single-flight:** not viable — each connection's query `id` differs (echoed on the result, which also re-seeds that conn's diff baseline) and serialize is the dominant cost, so a literal shared buffer is impossible; sharing only the SELECT rows leaves 21 serializes.
- **Reader-worker-thread query offload:** move the 665KB SELECT+serialize off the server event loop — larger architectural change; measure the two cheap levers first.
- **Per-connection socket backpressure cap + drain:** robustness against a slow consumer; separate concern from latency.

## Docs gaps

- **src/protocol.ts**: `MetaFrame` docstring (note nudges may be coalesced/throttled server-side); `QueryFrame.limit` stale `scripts/board.ts` example (only if the board's query frame changes — it doesn't under these levers, so verify before editing).
- **src/readiness-client.ts**: `SUBAGENT_INVOCATIONS_PAGE_LIMIT = 0` comment (:116) and the module docstring (lines 1-75) — verify the coalescer/backstop prose is accurate (the column-narrow keeps the same rows, fewer columns; confirm the `state.rows`-not-`byId` invariant block at :45-51 needs no edit).
- **README.md `## Architecture`**: the `meta` nudge prose (~lines 106-167) if server-side coalescing changes fan-out semantics.
