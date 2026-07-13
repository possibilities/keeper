## Overview

Two independent plan-execution robustness defects that corrupt board state on a *transient* failure. (A) At boot, a configured plan root whose filesystem-watcher subscribe rejects (EMFILE / fseventsd exhaustion) has its directory scan skipped, so the boot reconciliation sweep — reading a partial census as proof of absence — false-tombstones every epic and task under that root, briefly wiping that repo's board and driving autopilot to act on phantom-emptiness (tearing down lanes, mis-evaluating dependent readiness). (B) A close whose commit fails hard-exits via `process.exit(1)`, leaving a torn done-def on disk AND a leaked close-claim marker that wedges the epic at `CLOSE_ALREADY_CLAIMED`. Both fixes extend just-landed infrastructure — the `isWithinRoots` sweep-scoping and the `onCommitFailure` rollback machinery — rather than reinventing it.

## Quick commands

- `bun test test/plan-worker.test.ts`                              # Task A: boot-sweep census scoping (root fast tier)
- `cd plugins/plan && bun test test/saga-close-finalize.test.ts`   # Task B: failed-close re-closability (plan tier)

## Acceptance

- [ ] The boot sweep never tombstones epics/tasks of a configured root whose boot scan was skipped (subscribe failed), while still sweeping genuinely-absent rows of roots that scanned cleanly.
- [ ] A close whose commit fails leaves the epic re-closable on a clean rollback (no torn def, no leaked close-claim marker), or a visible needs-human wedge on an incomplete rollback — never a silent uncommitted `done`.

## Early proof point

Task that proves the approach: `.1` (plan-worker sweep scoping — clone the existing "epic outside configured roots is not retracted" test into "configured-but-unscanned root is not retracted"). If it fails: the `scannedRoots` subset is not reaching the sweep — verify the accumulator's enclosing scope and the sweep-call argument.

## References

- Builds on the `isWithinRoots` sweep-scoping (`src/plan-worker.ts:1987`) — extend the CALLER (pass a `scannedRoots` subset), do not fork the scoping.
- Builds on the `onCommitFailure` rollback machinery (`plugins/plan/src/commit.ts` — `snapshotForRollback` / `restoreForRollback`), which was generalized to scaffold / epic-create / refine-apply / assign-cells but NOT the close verb.
- Verified against current main. The client direct-merge / standalone `keeper plan epic close` path (`cli.ts`) holds no close-claim marker — the Task B fix must no-op it there and not regress its `commit_failed` + exit-1 contract.

## Docs gaps

- **CLAUDE.md** (event-sourcing / plan invariants, near "Never wipe-and-replay the live-only projections"): optional single imperative line — the boot sweep's retraction scope is the subset of roots whose boot scan completed, while the barrier count is all roots. At most one line, only if establishing a standing rule; the Task A test is the real enforcement — worker's judgment.

## Best practices

- **Never delete on absence in a partial census:** model each root present / absent / unknown; a skipped or errored scan is `unknown`, not `absent`, and retracting on `unknown` is the entire bug class (mark-sweep GC and K8s-controller convention — retract only on a *successful* scan's affirmative absence; fail the sweep closed on an incomplete census).
- **Throw/roll back, don't `process.exit`, on commit failure:** a hard exit abandons pending cleanup and leaves a torn write + stuck claim; keep the rollback and claim-release on the reachable path, and release the claim only as part of the rollback (after the write is undone), never before the commit is durable.
