## Description

Finding F1 (evidence: `src/bus-worker.ts:1015` `startTimeViaPs` and the
single-flight guard at `src/bus-worker.ts:~1890`). `startTimeViaPs` does
`Bun.spawn(["ps", ...])` then `await proc.exited` with no timeout, kill, or
AbortSignal. The retention timer's guard is
`if (retentionPass !== null) return; retentionPass = runRetentionPass()....finally(() => { retentionPass = null })`
— the `.finally` fires only when the pass settles, so a probe that never
exits pins `retentionPass` non-null forever and every subsequent tick
early-returns, permanently and silently wedging `pruneStaleChannels`,
message aging (`cleanupBusArtifacts`), control pruning, and the WAL
checkpoint/incremental-vacuum for the worker's life.

Bound the probe subprocess so a stuck `ps` cannot starve the single-flight
loop: add a timeout that kills the spawned process (or drive it via an
AbortSignal), and treat a timed-out/aborted probe as an inconclusive
result returning `null` — identical to the existing failure contract, so
the caller keeps the row and retries on a later pass. Keep the probe
cap (16/tick) and cursor semantics unchanged. `ppidViaPs` shares the same
unbounded `await proc.exited` shape; bound it consistently if the fix
generalizes, but the retention-loop wedge is the load-bearing case.

## Acceptance

- [ ] `startTimeViaPs` returns within a bounded wall-clock budget even
      when the spawned `ps` never exits; the process is killed on timeout.
- [ ] A timed-out probe returns `null` (inconclusive → row kept), matching
      the existing null-on-failure contract; no throw escapes.
- [ ] A deterministic in-process test proves a never-resolving probe does
      NOT leave `retentionPass` pinned — a subsequent tick runs a full
      pass (no real subprocess/daemon; probe injected via the existing
      `probeStartTime` seam).

## Done summary

## Evidence
