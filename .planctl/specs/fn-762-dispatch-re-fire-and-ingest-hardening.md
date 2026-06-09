## Overview

Close the dispatch re-fire windows that caused the 2026-06-09 incident (work::fn-759….3
triple-dispatched at ~125s spacing — three live workers on one worktree — because fold
lag outlived the co-expiring 120s cooldown and 120s pending-dispatch TTL; fn-7.1
re-dispatched 9x the same hour), and harden the two ingest/migration safety gaps the
deep review flagged: poison NDJSON lines silently wedging per-pid events-log files,
and migrate() silently regressing a newer DB under an old binary. Evidence:
~/docs/keeper-reliability/2026-06-09-server-deep-review.md + backstop.ndjson
(pending-dispatch-sweep timeout rescues at staleness_ms≈120400 for that verb::id;
autopilot-ceiling rescues 39/63).

## Quick commands

- `bun test --parallel --timeout=30000` — full suite green
- `grep -n 'REDISPATCH_COOLDOWN_S' src/autopilot-worker.ts` — 200, with the strictly-greater comment
- `bun test test/events-ingest-worker.test.ts` — poison-line sibling tests green (advance + dead-letter + telemetry; torn tail still blocks)
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT count(*) FROM dead_letters WHERE status='poison'"` — poison rows queryable post-deploy
- After deploy + bounce: no DUPLICATE-LIVE-WORKERS tripwire fires; `bun run scripts/backstop-stats.ts` pending-dispatch-sweep rescue count stops growing

## Acceptance

- [ ] no duplicate verb::id dispatch under fold lag up to ~200s: cooldown (200s) strictly outlives TTL (120s) + sweep (60s); indoubt re-stamps once at resolution; post-launch aborts keep the stamp; pre-launch aborts clear it
- [ ] dispatched-ack replies immediately after the committed INSERT (insert-durability contract); outbox ordering (insert before launch) unchanged; a pumpWakes throw cannot flip or escape the ack
- [ ] a seeded poison line is parked in dead_letters (status='poison', non-replayable), its offset advances, later lines in the same file still ingest, and a backstop record is emitted; a torn tail (no trailing newline) still blocks exactly as today; transient DB failures still block
- [ ] dead-letter replay binds INGEST_EVENTS_COLUMNS; a lockstep test pins INGEST_EVENTS_COLUMNS to the live events schema; stale EVENTS_COLUMNS deleted if orphaned
- [ ] a DB stamped SCHEMA_VERSION+1 makes openDb/migrate throw loudly (both versions + remediation in the message) before any write; schema-version test asserts membership, not max
- [ ] no schema bump; no keeper-py change; CLAUDE.md + README + docs/exec-backend.md passages updated per the epic Docs gaps

## Early proof point

Task that proves the approach: task 1 (cluster A). If the ConfirmOutcome split or the
re-stamp semantics can't be expressed without weakening the fn-742 finalizer-guard
parity, stop and re-derive against the fn-735 spec rather than special-casing.

## References

- ~/docs/keeper-reliability/2026-06-09-server-deep-review.md + 2026-06-09-roadmap-state.md (incident log + decisions)
- .planctl/specs/fn-735-*.md (cooldown design), fn-724-*.md (durable mint/confirm), fn-742-*.md (finalizer guard), fn-643-*.md (dead letters), fn-672-*.md (lockstep test)
- k8s controller_utils.go ExpectationsTimeout pattern — stamp-before-call + TTL strictly outlasting worst-case delivery delay (the headroom rationale)
- `fn-9` (overlap) — fn-9.3 deletes keeper's cli/find-task-commit.ts (target_repo=keeper); dep wired to serialize keeper-root work
- Decision record (gap analysis): aborted→{aborted-prelaunch, aborted-postlaunch} rename (compiler-forced site audit); poison rows = dead_letters status='poison' with deterministic dl_id incl. inode + ON CONFLICT DO NOTHING, same BEGIN IMMEDIATE as offset advance; blank-line check inlined in the scan loop (parseEventLogLine signature frozen — the hook imports it); ack-then-guarded-pump

## Docs gaps

- **CLAUDE.md ## Autopilot (fn-735 paragraph)**: 120s→200s, "aligned to"→"strictly >", abort-clear scoped to pre-launch, indoubt re-stamp clause [task 1]
- **CLAUDE.md ## Migrations**: runtime downgrade guard sentence [task 3]
- **README ~1782 + ~1962 + ~2000**: ack-now-pre-drain (outbox ordering unchanged) + cooldown value [task 1]
- **README ~408-425 ingester failure modes**: new numbered poison-line item (bold-scenario-label style); replay prose ~192-208: binds INGEST_EVENTS_COLUMNS [task 2]
- **docs/exec-backend.md ~140-143**: one-line ack-timing consistency note [task 1]

## Best practices

- **Stamp before the call, TTL strictly outlasts worst-case delay + sweep:** k8s ExpectationsTimeout pattern — suppression must cover the whole round-trip [kubernetes/kubernetes controller_utils.go]
- **Re-stamp only on ambiguous outcomes, once at resolution:** re-stamping on every retry is the perpetual-suppression bug class [openclaw#23516]
- **Poison: compute next_offset from the newline BEFORE parsing; advance on parse failure, block on transient downstream failure — never mix** [Kafka/Confluent DLQ semantics]
- **Downgrade guard fails hard at startup, names both versions** [sqlite user_version conventions; nwaku#2027]
