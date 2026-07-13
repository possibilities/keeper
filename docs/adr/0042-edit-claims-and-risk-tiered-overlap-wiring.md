# 42. Base freshness and rebase-cadence conflict prevention

## Status

Proposed. ADR number PROVISIONAL — assigned at merge (renumber if a sibling epic lands
one first).

## Context

Worktree lanes can remain based on an increasingly stale local default branch while other
lanes land work. The resulting base drift makes a later fan-in or finalize merge more
likely to conflict even when the independently-developed changes do not overlap. The
existing resolver → deconflict → terminal-page path handles these conflicts, but it is a
backstop rather than a reason to let stale bases accumulate.

The diagnostic measurement found base drift in 23 of 35 historical conflict incidents
(66%), while file overlap accounted for 10 (29%). That result redirects prevention from
plan-time write prediction and serialization to a producer-owned freshness check: measure
a lane base against local default, then refresh a safely idle base on a bounded cadence.

## Decision

1. **Measure base drift as producer data.** In worktree mode, the producer probes each
   `(epic, repo)` lane base against its local default branch and compares both behind-count
   and merge-base age with durable thresholds. It carries the resulting entries as plain
   reconcile-snapshot data for the pure reconcile core to consume; the core does not probe
   git, the filesystem, or the clock.
2. **Use a quiescent base-freshness gate.** When measured drift passes a threshold and the
   lane base has no live attributed session, the producer may merge local default into that
   lane's own linked base worktree. Refreshes are rate-limited to a bounded cadence so the
   mechanism adds neither continuous merge churn nor a new write path to the fold. A
   content conflict reuses the existing `worktree-merge-conflict` sticky and its resolver →
   deconflict chain; it does not create a new distress class.
3. **Keep freshness subordinate to the Merge-gate.** The Merge-gate still prevents a
   dependent lane from cutting ahead of upstream work that is not in local default.
   Base-freshness reduces the divergence that remains after that ordering check; it does
   not serialize independent tasks or claim to prevent every same-file conflict.
4. **Ground truth closes the loop out-of-band.** Conflicted file sets are captured by the
   merge producer and ride the DispatchFailed payload into a `dispatch_failures` column,
   covering fan-in, finalize, and base-refresh conflicts; the fold stores the
   event-carried set deterministically on re-fold. The out-of-band report classifies
   incidents as base-drift, file-overlap, or other rather than calibrating dropped write
   predictions.
5. **The build is gated by measurement.** The diagnostic already applied this gate and
   found base drift dominant, which selected this design instead of plan-time overlap
   machinery. The out-of-band report continues the measurement loop after the gate is
   built, including refresh activity and a proxy for conflicts prevented.

## Consequences

- A refresh costs a bounded extra default-into-base merge and may surface a conflict
  earlier, while preserving the existing resolver and deconflict backstop rather than
  inventing a parallel recovery path.
- Confidence is measurement-bounded: the diagnostic supports prioritizing base freshness,
  and the ongoing report must test whether refreshes correspond to fewer incidents rather
  than treating the mechanism as a safety guarantee.
- A continuously busy lane cannot become quiescent for refresh and is an accepted hole;
  cadence and threshold checks deliberately prefer avoiding interference with active work
  over forcing a merge into it.
- File-overlap conflicts, 29% of the diagnostic incidents, remain out of scope for this
  epic. The Merge-gate and escalation pipeline continue to handle them when they occur.
