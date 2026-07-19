# 95. Stopped-session occupancy reaping and dead-session claim release

## Status

Accepted. Amends ADR 0085; relates to ADRs 0052, 0060, 0070, 0071, 0083, 0084.

## Context

Four starvation shapes share one root: nothing alive can yield the withheld
resource, and the operator is the only reaper.

- A session that stops without yielding strands its occupancy. The occupancy
  pass classifies death only via proven-dead pid, bare-shell pane, or
  derived-idle activity; a stopped, pid-alive, non-bare-shell wrapper matches
  none of them, so the next mint refuses `slot-occupied` until a human TERMs
  the pid and retries. Observed across `work::` and `close::` alike, many
  times per day.
- A `close-finalize` that ends `fatal_halt` clears its disk markers and stops;
  nothing translates the terminal verdict into an occupancy release, so the
  retry mint is refused by the dead closer's own pane.
- An operator-killed session leaves its acquired Dispatch claim bound to a
  terminally dead session. ADR 0085's orphaned-claim reaper deliberately
  scans only sessionless claims, so the freed ready target starves (~25
  minutes observed) until a manual `autopilot retry`.
- Several decline paths (occupancy-pass signals, the degraded tmux-probe
  cycle) bypass the withhold rail, so the starvation above is silent.

ADR 0085's never-bound deadline formula was re-verified working during this
decision; the classes above are its uncovered siblings, not a defect in it.

## Decision

1. **Stopped-past-grace reap, any verb.** A session with positive `stopped`
   evidence (never a `working` row) past a grace window is reaped —
   TERM, bounded grace, then KILL — under the occupancy pass's existing
   conservative guards: working rows are never candidates, each sweep is
   blast-capped, and a degraded pane probe leaves the pass inert. Reap, not a
   silent occupancy drop: a released-but-live pid could resume and double-own
   the key, and kill-then-retry is exactly the operator recovery this
   automates. The KILL escalation is what collects a SIGSTOP'd pid, which
   receives TERM only on resume.
2. **The close saga's durable receipt is the fatal-terminal carrier.** The
   reconcile read joins a stopped `close::` session against its epic's latest
   close receipt; a `fatal_halt` receipt at or after session start makes the
   session immediately reap-eligible, with no grace wait. This is a
   positive-verdict release, distinct from the heuristic dead-probe arms. The
   plan plugin stays read-only toward keeper.db and the RPC surface does not
   widen.
3. **Dead-session claim release.** A sibling of 0085's ownerless release
   covers claims whose owning session carries terminal evidence (killed or
   ended) and whose attempt has settled-or-absent Provider-leg ownership.
   The producer plans a capped batch on heartbeat cadence; the fold re-checks
   every condition and treats a late bind, supersede, or leg enrollment as a
   no-op, mirroring 0085's restriction machinery. Claims with live or
   unsettled leg ownership remain visibly fenced — ADR 0071's
   settlement-before-release contract is unchanged.
4. **Withhold visibility is total.** Every reconciler decline of a ready
   target routes through the two-tier withhold rail (stable machine code plus
   bounded detail), including occupancy-pass signals and a probe-degraded
   sentinel for cycles where the tmux probe is down. There is deliberately
   NO durable withhold projection: reasons are ephemeral reconcile reads, and
   a per-cycle-churning projection would be a re-fold cost bomb. New codes
   register in `docs/problem-codes.md`.
5. **Vocabulary.** Existing slot-named identifiers and persisted reason-prefix
   strings stay as-is — reason strings are durable `dispatch_failures` data.
   New identifiers and withhold codes use the glossary's Dispatch-claim /
   occupancy vocabulary.

## Consequences

- The stopped-session treadmill ends: squatters of any verb are collected on
  grace, a fatal close verdict frees its occupancy immediately, and operator
  kills stop producing silent ~25-minute starves.
- SIGSTOP'd squatters actually die: KILL after TERM-grace collects a pid whose
  queued TERM would only land on resume.
- A withheld ready target is always explainable from the withhold surface,
  including during degraded probes.
- ADR 0085's deadline formula, batch caps, and jitter are untouched; the new
  release class composes beside it.
