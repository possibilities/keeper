## Overview

keeper's TUIs feel laggy: a real jobs/epics change takes a measured p50
~377ms / p90 ~1199ms to appear on the surface (mean 488ms), against a
server-side patch-frame arrival of p50 ~240ms / p90 ~698ms. Both halves
contribute. This epic lands the big, safe wins: the client renders the
pushed `patch` row directly instead of doing a refetch round-trip that
loses to the 500ms backstop (sidecars only — `subscribeCollection`), and
the daemon stops waiting on the second of two serial 50ms `data_version`
polls by kicking the server-worker straight after a fold. A third task
diagnoses the periodic poll-loop stalls (the 698/1199ms batch-flush
clusters) and decides — from real trace evidence — whether the fix belongs
in this epic or a follow-up.

The board (`subscribeReadiness`) direct-render is deliberately OUT of scope
(its `subagent_invocations` re-entrant-rows merge is the highest-risk,
lowest-payoff piece — it has no 500ms backstop) and will be reassessed
after remeasuring.

Every lever is gated by `scripts/bench-latency.ts` before/after (committed
2b1ee42). All three changes live in the read/serve/transport path — NONE
touches a fold, so re-fold determinism is untouched.

## Quick commands

- `bun scripts/bench-latency.ts --duration 30 --collections jobs` — measure jobs reality→surface latency (run before and after each lever)
- `bun scripts/bench-latency.ts --duration 30` — measure jobs+epics together
- `bun test test/readiness-client.test.ts test/server-worker.test.ts test/wake-worker.test.ts` — the three touched test suites
- `KEEPER_TRACE_SERVER=1 <run daemon>` — enable the server-worker sleep-overrun + diffTick-duration traces (lever C)

## Acceptance

- [ ] Lever A (sidecars): a `patch` frame renders directly (no refetch round-trip); `meta` frames still refetch; bench-latency jobs p50/p90 measurably drops
- [ ] Lever B: server-worker runs diffTick on a post-fold kick (poll retained as backstop); wake-worker poll lowered 50→25ms; bench-latency shows reduced fold→surface latency
- [ ] Lever C: poll-loop stall signature captured from real KEEPER_TRACE_SERVER traces; findings recorded; in-scope-vs-follow-up fix decision made on evidence
- [ ] All existing tests pass; README/CLAUDE.md updated where cadence/freshness prose changed
- [ ] No fold-path change — re-fold determinism invariants untouched

## Early proof point

Task that proves the approach: `.1` (sidecar direct-render). It's the
cheapest isolated win and the most measurable — bench-latency jobs p50
should drop sharply once the refetch round-trip and 500ms-backstop
dependency are gone. If it fails (merge corrupts the sidecar render or the
win doesn't materialize): revert to refetch, keep the version-guard
learnings, and reassess before B/C.

## References

- Prior epic `fn-2-keeper-uds-subscribe-server` task `.3` "Live subscription poll diff and push" — diffTick origin
- Commits `01d9130` (version-probe-first diffTick, Tier 3) and `83012ce` (diffTick id-set chunking) — diffTick already had perf passes; lever C stalls are residual
- `scripts/bench-latency.ts` (committed `2b1ee42`) — the before/after harness; NOTE its epics Δ excludes the `.planctl`→mint producer latency, so before/after must compare the same collection set
- Wire contract: `src/protocol.ts:174` `PatchFrame` carries the full row ("so the client renders without re-querying" :168) — relied on, unchanged

## Best practices

- **Version-guard the merge:** keep a per-`(collection, pk)` last-seen version (read each descriptor's version column — `last_event_id`, or `dl_written_at` for dead_letters) and drop any patch whose version isn't strictly newer. Belt-and-suspenders against reconnect-replay; the server already gates and UDS is in-order.
- **`meta` stays a full refetch:** a membership change can't be reconstructed from a single row.
- **Reconnect takes a fresh `result` first**, then re-arms the version cursor; the direct-merge branch must guard on `state.gotResult` so a patch never merges into a torn-down/unseeded page.
- **Kick AFTER commit, never before:** post the kick once `drainToCompletion` returns, or the server-worker can read a pre-commit `data_version` and miss the change.
- **Keep the level-triggered poll as backstop:** the edge-triggered kick is subject to a lost-wakeup race; the poll is the recovery path. Don't remove it.
- **Idempotent kick handler, no throw:** diffTick is sync + version-gated, so kick+poll double-fire is a harmless no-op; the worker message handler is in the no-self-heal path, so wrap diffTick in try/catch (log+continue), never propagate.

## Docs gaps

- **README.md `## Architecture` (~:961):** the "polls `PRAGMA data_version` at ~50ms" sentence → reflect 25ms wake cadence + the new main→server-worker postMessage kick as the primary fast path after each fold.
- **CLAUDE.md `## Worker contract` (~:277):** note the server-worker accepts a `{type:"kick"}` message from main as a supplementary fast-path wake; the poll is now the stall-recovery backstop.
- **CLAUDE.md `## DO NOT` "no kernel file watchers" rule (~:224):** clarify polling remains the sole *external* DB-change primitive; the in-process postMessage kick is a complementary same-process wake, not a file watcher.
