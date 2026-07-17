## Overview

Expose the durable-await cancel that ADR 0054 designed but never surfaced — an owner-fenced `keeper await cancel <await-id>` enforced producer-side per ADR 0072 — and make `keeper await`'s armed state truthful: the armed bit latches as lifecycle state regardless of `--no-armed-line`, closing a live false-fire path with `--require-transition`.

## Quick commands

- `bun test ./test/await.test.ts ./test/rpc-handlers.test.ts` — focused suites green
- `keeper await complete fn-9999 --durable` then `keeper await cancel <await-id>` from the same session — row reads cancelled, no follow-up ever fires

## Acceptance

- [ ] A waiting durable await can be cancelled by its arming session or via an explicit audited operator override, and by no one else; refusals are uniform
- [ ] A cancelled row never fires its follow-up, including a cancel racing a concurrent claim/fire
- [ ] Under `--no-armed-line`, `--require-transition` suppresses an already-met condition at arm time and fires on a genuine later edge
- [ ] The armed line's printed shape and the descriptor summaries are unchanged where semantics did not change

## Early proof point

Task 1 (ordinal 1) proves the armed-latch fix with the combined regression test. If it fails: the latch interacts with an unlisted reader — re-map `state.armed` consumers before the cancel work.

## References

- docs/adr/0072-owner-fenced-await-cancel-and-armed-line-semantics.md — the contract this epic implements
- docs/adr/0054-terminal-repairs-dead-writer-sweep-durable-awaits.md — the durable-awaits substrate (amended)

## Docs gaps

- **plugins/keeper/skills/await/SKILL.md**: add the cancel verb to the durable section; consolidate (not append to) the armed-line description
- **docs/adr/0054**: amendment landed with ADR 0072 (done at plan time)

## Best practices

- **Cancel is a compensating event, never a delete:** the fold's status CAS decides cancel-vs-fire by event order [River/event-sourcing canon]
- **Fire must re-check terminal state in its emitting transaction:** at-most-once effect comes from the durable fence, not delivery guarantees
- **Authorize from the row, deny by default:** the producer derives authority from the row's recorded arming session, never the caller's claim; uniform refusals avoid an existence oracle
