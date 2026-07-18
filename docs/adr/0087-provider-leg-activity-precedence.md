# 0087 — Provider-leg activity precedence in readiness staleness

## Status

Accepted. Provisional number — fan-in renumbering per ADR 0020/0022.

## Context

The readiness sub-agent staleness rule compares the injected `now` against the
`SubagentInvocation` row's `updated_at` alone. During wrapped delegation that
row does not advance: the wrapper yields, its `work:worker` invocation stays
open at its start timestamp, and the owned Provider leg — a separate top-level
job whose row advances continuously via folded events — carries the only live
progress evidence. The age-only rule therefore renders most healthy delegated
execution `running:sub-agent-stale`, presenting a warn pill for work that is
demonstrably active. Two operator-captured reproductions showed an actively
editing leg (fresh folded activity, dirty lane files) under a wrapper whose
board row read stale for the majority of the run.

The conservative property behind the stale verdict remains load-bearing: a
child that dies without a `SubagentStop` has no reducer backstop, so a
possibly-dead child must keep occupying the dispatch mutex rather than
releasing capacity on a guess (correctness over throughput).

## Decision

Positive owned-leg activity takes precedence over age-only child staleness.

- Readiness receives a new pure input: a map from wrapper job id to the
  freshest owned live Provider leg's activity timestamp, built by one shared
  helper consumed by both the reconciler input loader and the board client.
  The helper joins live-state Provider-leg ownership rows to the jobs
  projection explicitly; settled or transferred legs never contribute
  evidence. An absent leg row is no evidence, not an error.
- When every running sub-agent on a row is age-stale but at least one owned
  leg's activity is fresh within the same staleness window, the row renders a
  distinct `running:provider-leg-active` reason instead of
  `running:sub-agent-stale`. The verdict tag, mutex occupancy, and await
  semantics are identical to the other running reasons; only the stated
  evidence differs.
- The staleness window constant is shared: leg freshness is judged against the
  same threshold as invocation freshness, applied to the advancing leg
  timestamp. No timeout is raised and no second ceiling exists — a wedged leg
  stops folding events, its timestamp freezes, and the row re-stales through
  the unchanged conservative rule.
- Absence of positive leg evidence changes nothing: age-stale rows without a
  fresh owned leg render `running:sub-agent-stale` exactly as before, holding
  the mutex.
- The status tally (ADR 0083) is unchanged in structure: the new reason is a
  fresh running verdict and lands in `running`, never `stale_running`; the
  split continues to follow the verdict reason.

Wrapped `close::` cells delegate through the same staleness helper, so the
precedence covers task rows and close rows alike. The dash AGENTS-region
glyph derives child staleness separately; its divergence for a wrapped job is
an acknowledged cosmetic gap, not covered by this decision.

## Consequences

- Healthy delegated execution reads as active with a truthful, distinct
  reason, and operators can trust the warn pill again: stale now means "no
  positive evidence anywhere", not "the wrapper-side row aged out".
- The conservative orphan property survives byte-for-byte: with no leg
  evidence the predicate is unchanged, and an empty leg-activity input keeps
  the readiness pass byte-identical for replay and simulator equivalence.
- Evidence quality depends on which folded events advance a leg's job row; if
  a non-progress event ever bumps it, the precedence over-trusts a chatty leg
  for one window at most. Related lifecycle context: ADR 0056 (wrapped
  provider-leg window lifecycle), ADR 0069 (leg death notices), ADR 0071
  (durable wrapper-leg ownership).
