# 31. Finalize defers on an occupying closer; phantom-working cwd belt is detect-only

## Status

Superseded by [ADR 0055](../0055-harness-activity-dispatch-claims-and-resource-holds.md),
which carries forward the cwd-missing detect-only belt and fail-closed destructive-cleanup
posture while replacing the stopped-pane occupancy coupling. This record originally amended
the worktree recover-pass teardown and stuck-sentinel decisions.

## Context

The worktree finalize trigger collects epics from a union of two arms: the
closer-occupancy-aware `closerJobFinished` (a `close::<epic>` job row exists and
no longer occupies — `working` always occupies; `stopped` occupies while its
pane is live; a degraded pane probe occupies everything) and the
projection-done arm (the close row's readiness verdict flips `completed` when
the epic folds `done`). The projection-done arm consulted no closer occupancy,
so finalize could merge and tear down an epic's lane seconds after the close
commit landed — while the closer session was still mid-turn inside that lane.

The window was invisible while the close commit was a closer's last act. The
blocking-follow-up close gate (ADR 0028) gave closers a substantial post-close
tail (inline audit, follow-up planning, arming, final report), so the ungated
arm began tearing lanes down under live closers routinely. A session whose cwd
is deleted cannot spawn anything (`posix_spawn` ENOENT from a deleted cwd —
even `/bin/sh`), so its events-writer and Stop hooks die silently, its job row
wedges at `working` forever, and the zombie row ghost-holds per-root occupancy,
wedging dispatch board-wide. Every downstream belt correctly fails closed and
therefore never fires: autoclose requires done-and-idle, the exit-watcher
requires process death, the Tier-1 stuck sentinel keys `workerDone` off task
rows (a closer has none), and Tier-2's 60-minute net is far too slow.

## Decision

1. **Closer occupancy is a hard gate on every finalize arm and on recover-pass
   lane teardown.** An epic whose close job still occupies its slot (per the
   shared `isOccupyingJob` semantics) is not collected for finalize and its
   lane is not swept, that cycle — a self-resolving deferral, minting no row.
   No new liveness predicate, no cwd matching: the existing occupancy seam is
   the single authority, so reconciler and board cannot drift.
2. **The deferral intentionally ends at "no longer occupying," not at "process
   dead."** An idle-at-prompt closer occupies until its pane dies — in practice
   autoclose's reap ends the wait within its grace. This liveness coupling is
   the original (June) finalize design and is accepted: it fails closed under
   probe degradation and is bounded in the normal path.
3. **The phantom-working belt is detect-only.** A `working` job whose recorded
   cwd no longer exists on disk while its pid (recycle-checked) is alive mints
   a visible sticky needs-human distress row, scoped to plan-dispatched
   sessions. The daemon never kills on this signal; a probe error suppresses
   the page rather than minting one. Reclaim stays with the operator (or a
   future decision once the clause's false-positive rate is proven).

## Consequences

- Finalize (merge-to-default, push, teardown) lands a few minutes later than
  today's instant-on-close behavior — after the closer exits or is reaped.
- A crashed closer still finalizes: a dead pane does not occupy, and the
  projection-done confirmation is unchanged.
- Zombie closers become structurally unreachable via the teardown path; any
  residual variant (e.g. an operator deleting a live session's directory)
  surfaces through the cwd-missing distress row instead of silent occupancy.
