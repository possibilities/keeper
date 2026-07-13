# 0052 — Idle-slot reclaim, per-root cap honoring, degraded-read deferral, and the close recovery stamp

## Status

Accepted (provisional number; fan-in renumber per ADR 0020/0022 applies). Amends
[superseded ADR 0031](superseded/0031-finalize-defers-on-occupying-closer.md) — 0031 §3 deferred
slot reclaim to "the operator (or a future decision once the clause's false-positive rate is
proven)"; this is that decision. Touches ADR 0017 (turn-active escalation occupancy, unchanged) and ADR 0013/0024
(phantom-working / stuck-sentinel, complemented not replaced).

## Context

A supervised board drain (eight epics) required dozens of manual `kill`s: keeper-dispatched
sessions that finished their turn stayed alive-but-idle holding their per-root dispatch slot, and
under per-root serialization one idle zombie starved the whole root. The same drain surfaced three
adjacent defects: the stored `max_concurrent_per_root` is ignored exactly when it should apply
(worktree mode ON forces cap-1 per lane — the inverse of the glossaried Per-root cap semantics);
a transiently-erroring working-set read is coerced to an empty set, which a reap consumer would
read as "everything is a zombie" (a supervisor loop mass-killed two live wrapped workers on this);
and an epic whose lane was already merged to the default branch cycled close sessions forever
because no path could just land the terminal stamp.

## Decision

- **Idle-slot reclaim lives in `computeSlotOccupancy`** (the reconciler's existing slot reaper),
  as a new `dead`-classification arm: job `state = stopped` AND backend idle (derived — live pane,
  no turn activity; never a new column) AND past an injectable grace AND the slot is wanted
  (`wantsDispatch`). The reclaim kills the pane through the existing idempotent kill primitive;
  the occupancy predicates are NOT forked — the slot releases when the pane actually dies, so
  board display, escalation-cap accounting, and autoclose semantics stay byte-consistent.
  A `working` session is never reclaimable. The arm inherits a per-sweep blast cap and the
  pane-identity discipline (re-verify before signalling; PID+start-time where the kill path
  touches processes). Autoclose keeps its separate done-and-idle remit; the overlap race is
  benign because the shared kill primitive no-ops on a dead pane.
- **The per-root cap applies while worktree mode is ON** — the round-robin allocator honors the
  stored N across distinct lanes of one root (each lane stays cap-1), and floors to one when
  worktree mode is OFF, exactly as `CONTEXT.md`'s Per-root cap entry already states. The stale
  "hardcoded N=1 / carried but unconsumed" narration in reconcile-core is deleted. The stored N
  gains a modest sanity clamp at read time.
- **Degraded reads defer, never resolve.** The readiness-input reader distinguishes an ERROR
  frame from a genuinely-empty result: errors mark the inputs degraded, and a degraded tick is
  skipped by reap/occupancy consumers AND the dispatch pass (absence of an observation is never
  resolution — the level-triggered reconciler simply runs next tick). A genuine empty set stays
  a valid observation so a fresh board still dispatches.
- **The close recovery stamp is recovery-only.** A producer-side probe (mirroring the recover
  pass; the pure core only reads the snapshot fact) may land the terminal close stamp directly —
  by shelling the plan CLI's `epic close`, the daemon never writes plan state — ONLY when all
  three hold: every task is done, the epic's lane is POSITIVELY an ancestor of the local default
  (absence is never evidence; worktree-OFF epics never short-circuit), and at least one prior
  closer session finished without landing the stamp. The stamp is single-flight behind the same
  per-epic in-flight dedup as closer dispatch and records an explicit recovery marker, so the
  audit pipeline is bypassed only where closers already failed, and visibly.

## Consequences

An idle-at-prompt closer no longer occupies until its pane dies (revises 0031 §2); reclaim is
automatic past the grace instead of operator-owned (resolves 0031 §3's deferral). Raising the
effective per-root concurrency un-serializes shared-checkout git ops and SQLite writes that the
accidental cap-1 was hiding — operators should ramp N in steps and watch lock-wait/tail latency
rather than jumping. A close that lands via recovery stamp carries no audit verdict or follow-up
epic; the marker makes that auditable post-hoc. Degraded ticks trade one cycle of latency for
immunity to mass-kill/over-dispatch on flaky reads.
