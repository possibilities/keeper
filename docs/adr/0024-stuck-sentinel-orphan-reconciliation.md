# 24. Stuck-sentinel orphan reconciliation

## Status

Accepted. Amends [ADR 13](0013-jobs-lifecycle-stamp-and-stuck-sentinel.md)'s layer
3: the sticky anomaly row stays operator-ack-only for a LIVE-job firing, but a row
whose job is genuinely gone now self-clears.

## Context

ADR 13's stuck-sentinel row is deliberately ack-only — a silently self-tidying
corrector is how the underlying contradiction class stayed invisible for weeks — so
the ONLY sanctioned clear was `retry_dispatch`. That assumed an operator
investigating a firing row could always find its job. An incident surfaced the gap:
seven open sentinel rows, five pointing at job ids absent from the `jobs` table
entirely. Nothing was left to inspect — the rows were pure accumulating noise, not
evidence, and the ack-only design gave no path to shed them.

## Decision

The reconciler reconciles the two principles instead of picking one: each cycle, an
open `stuck-sentinel:<jobId>` row is checked against the RAW `jobs` table (every
state — a terminal `ended`/`killed` row still counts as present, since that job's
row is not gone, only finished). A row whose job id resolves in ANY state is
untouched, unchanged from ADR 13: it stays ack-only, `retry_dispatch` its only
clear. A row whose job id resolves in NO state — a genuine orphan — is garbage
collected: a loud trace line names the job id BEFORE the `DispatchCleared` fires, so
the evidence the ack-only discipline exists to preserve survives the row's removal.
The check reads the writable connection's own tables directly, never the
default-filtered `jobs` collection (which hides terminal rows and would otherwise
misclassify a job that finished normally as "absent").

## Alternatives rejected

- **Block job-row pruning while an un-acked sentinel references it.** No
  steady-state path prunes a `jobs` row — rows persist until a schema-rewind full
  re-fold, which reconstructs identically from the replayed event log. There was
  nothing live to guard against; this would have coupled an ack-only forensic
  signal's lifetime to job-row retention for a problem that does not occur.
- **Widen the ack-only clear to any terminal job state.** Rejected: a job that
  finished normally after a sentinel fired is not evidence the fold gap resolved
  itself — the row still names a real layer-1 contradiction an operator should see,
  so only a genuinely absent job counts as resolved.

## Consequences

- A sentinel row can now clear two ways: `retry_dispatch` (operator, any live job)
  or the orphan sweep (producer, job id absent). The two never race — the sweep
  only fires when the job id has no `jobs` row at all, a state `retry_dispatch`
  never depends on.
- The board no longer accumulates un-actionable rows from jobs the projection has
  already dropped; `keeper query dispatch_failures --json` stays a reliable
  needs-human surface post-deploy.
- No schema change: the sweep is a producer-side read-and-clear, the same
  `DispatchCleared` synthetic event every other level-triggered clear already uses.
