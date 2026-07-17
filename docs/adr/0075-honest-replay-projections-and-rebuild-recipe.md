# 0075 — Honest replay projections, the epic-index memo, and the rebuild recipe

Status: Accepted (provisional number; renumber at fan-in)

## Context

The event-store status block projects two durations from the last boot
catch-up sample: how long a catch-up would take now, and how long a full
from-scratch replay would take. Both currently scale the same wall-clock
rate. That rate is dominated by the boot drain's deliberate per-fold pacing
sleep plus tiny-sample overhead — a quiet boot samples a handful of events at
~25 ms/event — while a real rebuild runs mostly unpaced. Measured against the
live log, a full rebuild folds ~0.2 ms/event: the wall-clock extrapolation
overstates rebuild time by roughly two orders of magnitude, which poisons any
threshold that gates checkpoint/archive work on projected rebuild time.

Separately, a from-scratch rebuild bulk-loads the event log into a fresh
database whose `sqlite_stat1` was stamped over empty tables. The query
planner then mis-plans the git-attribution per-file seek (an index walk over
every PostToolUse row in range instead of the covering-index seek), turning
multi-second folds into the dominant rebuild cost. `ANALYZE` after the bulk
load restores the covering-index plan for seconds of cost.

Inside the reducer, the epic-dep index is rebuilt by a full `epics`-table
scan on every epic fold — the last O(board) fold cost. The epic fold writes
its own row before reading the index, so an invalidate-and-rebuild cache
would go cold on every fold and bound nothing: only in-place maintenance
bounds the hot path. Unlike the existing append-only watermark memos (which
are live-only pure optimizations), this index feeds the deterministic
`resolved_epic_deps` projection, so any cache must be provably byte-identical
to the fresh scan.

## Decision

- **Two rates, two projections.** The catch-up projection keeps the
  wall-clock rate — pacing is real experienced catch-up latency. The
  full-replay projection derives only from accumulated per-fold work time
  (stamped after the write lock is held, pace-free), sampled over exactly the
  same event window as the folded-event count. A missing or non-positive
  work measurement, or `events_folded < 1000`, makes the full-replay
  projection null — "not measured" — never a zero or a paced-rate
  extrapolation. The floor applies only to full replay: its total-event-count
  multiplier can amplify a small sample's noise without bound, while the
  catch-up projection's pending-events multiplier is small and bounded.
- **The full-replay projection is an estimator, not a promise.** It is the
  last boot's unpaced fold rate times the current event count. The sanctioned
  disaster-rebuild recipe is: bulk-load the log in one transaction, run
  `ANALYZE` (bounded by `analysis_limit`), then fold. Any offline rebuilder
  re-ANALYZEs before folding; skipping it forfeits the projection's accuracy
  by orders of magnitude.
- **The epic-dep index is an in-place-maintained per-connection memo.** It
  seeds with one full scan on first read and is patched — never dropped — by
  the same fold that mutates an index-relevant column (`epic_id`,
  `epic_number`, `project_dir`, `status`), only when the write actually
  landed. Patches re-read the single mutated row so column coalescing matches
  the scan exactly, and keep number buckets in scan order. Byte-identity to
  the fresh scan is the contract, enforced by warm-vs-cold and
  refold-equivalence gates; harnesses that wipe the epics projection on a
  live connection reset the memo alongside the wipe.
