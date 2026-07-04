# 1. Event-sourced control data over a mutable store

## Status

Accepted.

## Context

keeper is the control-data daemon for a fleet of coding agents: it tracks jobs,
epics, tasks, dispatch failures, and bus presence, and many producers write
concurrently while humans and agents read a live board. A conventional design
would keep mutable rows and update them in place. That makes the current state
easy to read but throws away how it was reached, couples every writer to the
schema, and makes a bad write unrecoverable — there is no ground truth to rebuild
from once a row is clobbered.

## Decision

State is an append-only log of immutable, totally-ordered events. Every mutation —
including ones a human or RPC requests — is recorded as a **synthetic event** and
then folded, so there is exactly one write path and one source of truth. Read
models are **projections** the reducer derives by **folding** the stream; they are
disposable and rebuildable at any time by re-folding from event zero. A projection
is never itself a source of truth, and no code updates one out of band.

Re-fold determinism is a hard invariant: a fold is a pure function of the event
and prior projection, never reading wall-clock, environment, process liveness, or
the filesystem. State that genuinely depends on the live world is modeled as a
separate live-only projection that is refreshed in place, not replayed.

## Consequences

- The full history is always available; the board can show not just what is true
  but how it became true, and a corrupted projection is fixed by re-folding.
- Every writer goes through the event log, so new mutations add an event kind
  rather than a new table or a direct-write path — writes stay tightly scoped.
- The cost is discipline: folds must stay pure and total (a malformed event folds
  to a safe value and still advances the cursor, never throwing), and any fold
  whose per-event work grows with history is a re-fold time-bomb that must be
  modeled live-only or as a bounded incremental memo instead.
- Live-world state cannot be replayed and needs its own refresh-in-place path,
  kept strictly separate from the deterministically-replayed projections.
