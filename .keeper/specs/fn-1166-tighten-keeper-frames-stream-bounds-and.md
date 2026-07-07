## Overview

Two edges survived the fn-1161 frames audit, both about the `keeper frames`
stream keeping its word on a quiet board. `--max-frames N` alone arms no
wall-clock teardown, so an idle stream that never reaches N data frames hangs
until SIGINT; and the agent-facing AGENT_HELP advertises a `keepalive` record
type that no production viewer ever emits. Both are contract-honesty fixes on
the frames surface — small, bounded, and worth landing so the tool behaves as
its runbook says.

## Acceptance

- [ ] `keeper frames --max-frames N` (no `--for`/`--follow`) is time-bounded — an idle board flushes a trailer and exits rather than hanging.
- [ ] The `keeper frames` agent-facing contract (AGENT_HELP + record types) matches what production actually emits — no advertised record type is unproduced.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | cli/frames.ts default-duration floor is bypassed once --max-frames is set, so --max-frames alone arms no teardown and an idle board hangs; help reads as an unconditional bound. |
| F2 | kept | .1 | src/frames-emitter.ts emitKeepalive has zero production callers yet cli/frames.ts AGENT_HELP advertises the keepalive type — the runbook documents a record production never emits. |

## Out of scope

- Any change to the wire framing, exit taxonomy, or coverage-honesty semantics — the audit confirmed those land correctly.
- The autopilot / watch skill-doc prose — verified consistent with the CLI grammar.
