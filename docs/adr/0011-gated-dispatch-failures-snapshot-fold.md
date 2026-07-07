# Dispatch failures ride the readiness snapshot as a gated fold

## Status

Accepted

## Context

The `dispatch_failures` collection backs three of the six needs-human signals
(stuck dispatches, finalize non-fast-forward, the instant-death wall), and its
consumers each reach it a different way: `keeper status` runs a one-shot
out-of-band `queryCollection` beside its readiness subscription, `keeper await`
opens a bespoke per-surface collection stream gated to `drained
--fail-on-stuck`, and `keeper watch` has no access at all. The event-driven
supervision surfaces (watch deltas and await conditions for the needs-human
family) need the rows push-delivered, which forces a choice between two
shapes. Per-surface collection streams keep the shared snapshot untouched but
add a socket per consumer, and `keeper watch`'s delta pipeline is single-input
snapshot-shaped — a side stream cannot ride its coalesce/flap-settle machinery
without new plumbing. Folding the collection onto the shared
`ReadinessClientSnapshot` unifies all three consumers on one row-set, but the
snapshot's first-paint byte-shape is load-bearing for board/dash/await/status,
and an unconditional fold would change every consumer's paint gate.

## Decision

`dispatch_failures` joins `ReadinessClientSnapshot` as a gated opt-in fold on
the `includeRecentDoneEpics` recipe: the subscription state is created only
when `SubscribeOptions.includeDispatchFailures` is set (else null), and both
the states-array push and the first-paint gate are guarded on non-null, so a
non-opt-in consumer's first paint stays byte-identical. The fold subscribes
unbounded (`limit: 0`): the collection self-prunes as stickies resolve, and
exact row counts are load-bearing for the instant-death-wall threshold — a
silent page-cap truncation is the worse failure than an unbounded small
collection.

Consumers converge on the fold: `status` drops its out-of-band query, `await`
deletes its bespoke stream and derives the opt-in from its parsed condition
set, and `watch` opts in for the needs-human delta family. One shared pure
projector owns the reason classification — the broad sticky row count and the
narrow operator-jam class — so every surface derives its counts from the same
math.

## Consequences

- One socket and one row-set serve status, watch, and await; the three
  surfaces cannot drift on what "stuck" contains.
- Alarm surfaces (watch deltas, await conditions) fire on the operator-jam
  class only, while the status envelope keeps displaying the broad sticky
  count — a principled, single-sourced divergence rather than drift.
- The snapshot member is absent (not null, not empty) for un-opted consumers;
  the off-path proof obligation is the subscribe-collection count staying
  unchanged when the flag is off.
- Any future collection joining the snapshot follows the same gated recipe:
  flag on `SubscribeOptions`, null-guarded state, spread-when-present member.
