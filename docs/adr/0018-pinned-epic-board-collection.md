# 18. Pinned-epic board collection

## Status

Accepted

## Context

A worktree-mode epic can be plan-closed (`done`) while its finalize merge is still
conflicted: the epic drops off the open-filtered board the moment it closes, but its
live `close::`/`work::` dispatch-failure rows keep needing an operator. The only
surviving surface was the one-line orphan entry in the top-of-board `needs human`
block — the full epic block (tasks, status pill, `[failed:<kind>]` pill) vanished
exactly while the epic demanded attention. The board's default `epics` collection is
deliberately open-filtered, and widening that filter would silently change semantics
and summary counts for every consumer.

Three designs were considered for making such an epic visible: widening the default
`epics` collection filter, a render-only status pill derived from the `epics.status`
column, and a dedicated opt-in collection merged into the readiness input. The
render-only pill cannot produce close-row verdicts without duplicating readiness
logic; the filter widening breaks every existing consumer's `open` semantics.

## Decision

A **pinned epic** is served by a dedicated narrow subscribe collection: every epic —
any status — keyed by a live `close::`/`work::` dispatch-failure row. The collection
is opt-in on the readiness subscription (flag on `SubscribeOptions`, null-guarded
state, spread-when-present snapshot member), so un-opted consumers' frames stay
byte-identical.

- **Membership** is a coarse SQL superset restricted to `verb IN ('close','work')`
  (a `daemon`-verb distress row embedding an epic id never pins), matching the bare
  `close::<epic>` key, the worktree-prefixed close forms, and `work::<epic>.<n>`
  task keys; the client narrows and homes candidates through the failure-key
  vocabulary (`resolveFailureTarget`), which stays the sole authority on key→epic
  mapping. SQL over-selects; TypeScript decides.
- **Verdicts** come from merging pinned epics into the readiness input set
  (open-wins, the same merge the recent-done overlay uses), so the block renders
  through the ordinary epic-block path with real readiness/close verdicts — no
  bespoke render fork.
- **Pin lifetime is the durable failure row's lifetime**: membership is re-derived
  from `dispatch_failures` on every serve — no timer, no in-memory latch — so a pin
  survives daemon restarts and clears the serve after the row clears.
- **Display-only**: a pinned epic never counts into the needs-human jam total, never
  gates dispatch or close, and a failure homed to a pinned block leaves the orphan
  needs-human line (exactly one surface per failure). The collection is unbounded by
  page limit — its size is bounded by the dispatch-failures table itself.
