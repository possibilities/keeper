## Overview

An epic with a live `close::`/`work::` dispatch-failure row keyed to it stays visibly
on the board — full epic block with its real status pill and `[failed:<kind>]` pill —
until the row clears, regardless of plan status. Today a plan-closed epic with a stuck
finalize drops to a one-line orphan entry in the needs-human block exactly while it
needs an operator. Governing decision: docs/adr/0018-pinned-epic-board-collection.md
(display-only opt-in collection, coarse-SQL/TS-homed membership, readiness-input merge,
pin lifetime = durable row lifetime). Glossary: CONTEXT.md "Pinned epic".

## Quick commands

- bun test test/collections.test.ts test/readiness-client.test.ts test/board.test.ts test/status.test.ts

## Acceptance

- [ ] A plan-closed epic with a live close/work dispatch-failure row renders as a full
      epic block on `keeper board` (real status pill + `[failed:<kind>]` pill) and
      disappears the serve after the row clears
- [ ] Each such failure surfaces in exactly one place: the pinned block's pill, not the
      orphan needs-human line; the `[needs-human:N]` banner count does not double-count
- [ ] Un-opted subscribe consumers' frames stay byte-identical
- [ ] `keeper status --json` `board.epics` carries the pinned epics with their
      dispatch_failure kinds (TUI/JSON parity)

## Early proof point

Task that proves the approach: ordinal 1 (collection + readiness-input merge). If
`computeReadiness` misbehaves over closed epics: fall back to a render-time status
pill derived from the epics status column (the rejected alternative in ADR 0018 —
re-open that ADR section before switching).

## References

- docs/adr/0018-pinned-epic-board-collection.md — the decision this epic implements
- docs/adr/0011-gated-dispatch-failures-snapshot-fold.md — the gated opt-in recipe
  (flag on SubscribeOptions, null-guarded state, spread-when-present member)
- `fn-1171` (dependency) — its done task .5 built the top-of-board needs-human block,
  banner count, and status needs_human subset this epic slots into
- `fn-1172` (overlap → sequenced after) — its in-progress task .3 REMOVES the
  epics_selection_review collection across src/collections.ts, src/readiness-client.ts,
  cli/board.ts, cli/status.ts. Cite/clone the SURVIVING includeDispatchFailures opt-in
  as the living precedent, never the selection-review one being deleted; expect these
  four files to have moved since planning — re-read before editing
- cli/board.ts render surface is contended (another session is doing TUI work) —
  re-verify line refs before relying

## Best practices

- **Single keyed projection:** reduce open + pinned into one epicId-keyed set before
  render; the list is a sort over that map, never a concatenation — the structural fix
  for dedup and double-counting [event-sourcing stream-merge consensus]
- **Pin lifetime = row lifetime:** derive membership from the durable dispatch_failures
  row every serve — no timer, no in-memory latch — so pins survive daemon restarts
  (Prometheus keep_firing_for restart-loss is the anti-pattern)
- **Stable sort key:** a pinned closed epic holds its board slot (epic-number order);
  never sort by a status-derived rank that makes rows jump between frames
- **Additive protocol evolution:** un-opted subscriptions get byte-identical frames;
  never start emitting a defaulted member that used to be omitted [AIP-180]
