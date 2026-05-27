## Overview

Two test-reliability gaps surfaced in the fn-622 audit: the diffTick slow-tick gate test can silently pass with zero emitted lines on a fast machine (hiding a broken gate), and the migrate:false hook guard is only tested against a fully-missing schema — not against the stale-schema case (events table present, newer columns absent) that CLAUDE.md explicitly calls out.

## Acceptance

- [ ] diffTick slow-tick test deterministically asserts at least one op=diffTick line is emitted when threshold is exceeded
- [ ] migrate:false stale-schema test exists and pins that insertEvent fails gracefully with a column-binding error distinct from the missing-table error

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| f-001  | kept   | .1 | Confirmed at test/server-worker.test.ts:1822-1832 — test explicitly accepts zero lines as passing; gate can be silently broken on fast CI machines |
| f-002  | culled | —  | close handler (line 711) unconditionally clears reconnecting=false; latch cannot get permanently stuck through any code path |
| f-003  | kept   | .2 | CLAUDE.md explicitly names "missing OR stale" schema; line 195 tests missing-table only; stale path (events table present, newer columns absent) hits a different prepareStmts error and is untested |

## Out of scope

- pollAll slow-flight order dependency — one-poll delay on a diagnostic event, not user-visible
- KEEPER_TRACE_FRAME_BYTES=0 edge case — diagnostic-only behavior
- diffTick threshold env-var knob (KEEPER_TRACE_TICK_MS) — future enhancement, no current impact
