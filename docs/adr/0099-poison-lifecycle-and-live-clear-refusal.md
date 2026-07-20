# 99 — Poison lifecycle and live-clear refusal

## Status

Accepted. Provisional number pending fan-in renumbering per ADR 0020/0022.
Amends [ADR 0070](0070-attempt-and-incident-fenced-dispatch-clears.md) and
[ADR 0063](0063-commit-work-explicit-adoption-and-atomic-publication.md) /
[ADR 0068](0068-commit-work-adoption-refinements.md).

## Context

Three host-wide commit outages in one day traced to two gaps. First, a poison
dead letter has no lifecycle: `replay_dead_letter` recovers only `waiting`
rows, no resolve verb exists, and the commit-work gate blocks every mutation
host-wide on any non-`waiting` row — while the stuck-birth GC parks fully
parseable birth records under that same globally-blocking status, and the
needs-human counter (filtered to `waiting`) shows zero throughout. Second,
the ADR 0070 fence compares attempt identity snapshotted at append, so an
operator `retry_dispatch` racing its own successful re-mint clears the LIVE
worker's claim — the fence checks identity equality, never liveness — and the
reply path reports `ok:true` even for a fenced no-op.

## Decision

1. **Poison gains a lifecycle.** A re-classification path re-parses a poison
   row's raw payload with the CURRENT parser into a full events envelope
   (preserving the original event `ts`; never a bare status flip) and replays
   it; a still-unclassifiable parse is a non-error terminal. An audited,
   bounded operator resolve verb writes a distinct terminal status that both
   commit-gate predicates and the retention prune explicitly recognize.
   Resolve and force are first-class audited actions carrying operator
   identity and reason. Replay is rate-bounded and ordered after producer
   fixes.
2. **The dead-letter gate scopes its blast radius to the record's evidence**
   (amends 0063/0068's unconditional fail-close): a row whose trusted
   producer-derived evidence names a session/worktree blocks only that scope;
   only genuinely unscopable rows block globally, and those surface loudly in
   the needs-human counter alongside a distinct poison count. Scope derives
   from producer state, never from attacker-influenced self-reports.
3. **Classifiable stuck births leave the blocking rail.** A birth record is a
   session mint, not a mutation receipt; the stuck-birth GC parks parseable
   records under a distinct non-blocking status that doubles as the earlier
   grant-starvation signal. Only unparseable birth-tree bytes remain poison.
4. **A dispatch clear refuses to release a live claim** (amends 0070 point 4):
   the operator clear path gates on a compare-and-swap against the monotonic
   attempt identity at the write site plus a producer-side process-identity
   liveness probe that refuses on uncertainty. `--force` overrides the
   liveness refusal only, never the identity match. The refusal returns a
   typed outcome through the retry reply instead of `ok:true`. Folds never
   probe liveness; the committed event replays byte-identically.

## Consequences

- One poison row can no longer halt unrelated work host-wide, and operators
  see the row, its scope, and its recovery verbs instead of a zero counter.
- `retry_dispatch` self-refuses where the doctrine previously demanded a
  manual TERM-confirm-dead precondition; the escape hatch is explicit,
  audited, and identity-fenced.
- The internal-sweep clear paths must prove they never delete a live bound
  attempt's mint gate; the fence work carries that regression proof.
- CLAUDE.md's RPC-surface list changes only if the resolve verb lands as a
  new RPC rather than an extension of the existing replay surface; the
  implementing epic settles that and updates the guardrail line in the same
  change.
