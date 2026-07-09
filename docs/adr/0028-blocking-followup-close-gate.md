# 28. A blocking follow-up holds its source epic open via a durable board gate

## Status

Accepted.

## Context

The close audit can produce a follow-up epic whose survivors correct something
the source epic establishes and exposes — a contract, schema, or invariant a
consumer would build on wrongly. Epics that hard-depend on the source unblock
the moment it stamps done, so closing before such a follow-up lands lets every
current and future dependent build on the flawed surface. The close stamp is
the system's one non-compensable pivot: there is no compensating action for a
close that leaked through.

Two enforcement shapes were weighed. A session-held wait — the scaffolding
closer arms `keeper await complete <followup>` and parks until it fires — needs
no daemon change, but parks a worker slot for the lifetime of an entire epic,
survives restarts only by degrading to re-dispatch, and hangs correctness on
pane liveness. A durable board gate — committed plan metadata plus a
level-triggered readiness predicate — needs a schema step and a new close-row
predicate, but survives crashes, reboots, and week-long follow-ups with zero
session state, matching the reconciler's level-triggered grain.

A second tension: the gate needs state on two epics (which follow-up blocks,
which source is blocked), and writing two pointers as two operations is the
classic dual-write tear — a crash between them either leaks the irreversible
close through or blocks the source forever on a phantom.

## Decision

Blocking is a durable board gate, never a parked session. The blocking branch
of `close-finalize` scaffolds the follow-up and returns a terminal outcome that
leaves the source open; a new close-row readiness predicate holds the source's
close row `blocked:close-followup` until the follow-up is done and close-idle,
and the reconciler then dispatches a fresh closer that adopts the follow-up and
stamps the close. A `keeper await` monitor may still be armed as a latency
shortcut; losing it changes latency, never correctness.

Exactly one field is committed: `blocks_closing_of` on the follow-up, stamped
atomically with its scaffold. The source side is derived read-time — a per-pass
reverse index over the folded `blocks_closing_of` column — so there is no
second pointer to tear or drift, mirroring how `resolved_epic_deps` re-derives
from upstream folds rather than trusting a cached stamp.

The blocking follow-up's `depends_on_epics` is the still-resolving subset of
the source's own deps and never the source itself: a follow-up→source edge
deadlocks (the follow-up's tasks would wait on source-done while the source's
close waits on the follow-up). The copy is inert at mint time — every entry is
already satisfied — and is kept for DAG position and provenance; the real
sequencing effect is the source staying open, which freezes its dependents.

## Consequences

- The gate covers dependents created after the decision for free: they block
  on the open source through ordinary `dep-on-epic` readiness, with no
  rewiring of their dep lists.
- `followup_blocks_close` joins `CloseOutcome` as the only member that does
  not stamp the epic done, and it must release the close-exclusive marker so
  the adopting closer can claim it.
- The scaffold dep validator's status-blindness becomes a load-bearing,
  tested carve-out: the substituted deps point at done epics by construction.
- Under armed mode the close skill must arm the follow-up via
  `set_epic_armed`, or the gate waits on a human — the armed closure walks
  upstreams and nothing points at a fresh follow-up.
- A follow-up deleted while a gate points at it is the one silently-wedging
  state; a producer-side sweep escalates the dangling pointer as a sticky
  needs-human row. The follow-up's own failure modes page through their
  existing surfaces — the source is never paged in parallel.
