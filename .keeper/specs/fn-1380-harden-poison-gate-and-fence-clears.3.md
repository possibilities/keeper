## Description

**Size:** M
**Files:** src/daemon.ts, src/rpc-handlers.ts, src/server-worker.ts, cli/, src/commit-work/surface.ts, test/daemon.test.ts, test/rpc-handlers.test.ts, docs/problem-codes.md, CLAUDE.md

### Approach

Poison rows get exactly two exits, both operator-owned. (1)
Re-classification: re-parse the row's raw bindings with the CURRENT
parser; success rebuilds a full events-column envelope preserving the
ORIGINAL event ts (a bare status flip throws today — bindings carry no
events columns; wall-clock ts would break re-fold determinism) and
replays it through the existing recovery path; a still-unclassifiable
parse is a non-error terminal leaving the row poison. (2) Resolve: an
audited, bounded operator verb writes a distinct terminal status
carrying acting identity + reason; both commit-gate predicates
(surface.ts reads status != 'recovered' at one site and status !=
'waiting' at the other — teach BOTH the full terminal vocabulary) and
the retention prune recognize it. Re-classification is rate-bounded
(one row per invocation, matching the existing replay's LIMIT 1 shape)
and idempotent. The RPC surface decision is this task's to settle:
extending replay_dead_letter reverses its deliberate param-less design,
so prefer a sibling RPC with the same audit rigor and update the
CLAUDE.md RPC-surface guardrail line in the same change; if extension
wins instead, CLAUDE.md stays. Wire the CLI verb with the force/audit
shape of the await-cancel precedent.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:7740-7800 — recoverOneDeadLetter (the INSERT rebuild from INGEST_EVENTS_COLUMNS ∩ bindings; :7794 throws on poison's {raw,file} bindings; :7746 preserves row.ts — the determinism contract)
- src/dead-letter.ts:289 — parseEventLogLine (the current-parser re-classification entry)
- src/commit-work/surface.ts:815,829 — the TWO gate predicates with different non-blocking definitions (the PQ2 integration risk)
- src/daemon.ts:5831 — pruneRecoveredDeadLetters (new terminal status arm)
- src/rpc-handlers.ts:88-119 — replay_dead_letter's param-less-by-design doc + the sibling-RPC note
- src/server-worker.ts:424 — decideAwaitCancel (the audited force-gated decision shape)

**Optional** (reference as needed):
- CLAUDE.md "Writes are tightly scoped" — the guardrail line a new RPC must update
- docs/adr/0099-poison-lifecycle-and-live-clear-refusal.md — the decision record

### Risks

- A terminal status the gate does not recognize still blocks the commit rail — the highest-risk integration point; test both predicates explicitly
- A resolve status with no prune arm strands rows forever
- Mass re-classification floods the one-at-a-time replay path — keep the bounded shape; root-cause-first is operator doctrine, not code

### Test notes

Seed poison rows (fossil-parser class: raw parses under current parser;
genuine class: raw stays unparseable); assert re-classify replays with
original ts, still-unclassifiable is non-error, resolve writes audited
terminal status, both gate predicates unblock, prune reaps, double
resolve is idempotent.

## Acceptance

- [ ] A poison row whose raw payload parses under the current parser replays as a real event carrying its original timestamp, and re-fold reproduces the projection byte-identically
- [ ] A still-unclassifiable row re-classifies to a non-error terminal outcome and remains poison
- [ ] The resolve verb writes an audited terminal status (acting identity + reason) that both commit-gate predicates treat as non-blocking and the prune ages out
- [ ] The RPC-surface decision is settled and the CLAUDE.md guardrail line matches the landed surface
- [ ] The operator verb refuses double-resolution idempotently

## Done summary

## Evidence
