## Description

**Size:** M
**Files:** src/bus-db.ts, src/bus-worker.ts, test/bus-db.test.ts, test/bus-worker.test.ts

### Approach

bus.db grows unboundedly (measured: 2,768 channel rows, 218,544 message rows, 30MB) and
amplifies every boot: the registry rehydrate seeds from ALL channel rows filtered by pid-only
liveness (recycled pids keep stale rows alive forever — the likely accumulation mechanism),
and registryList() iterates every entry on every fanout/resolve/list.

Retention runs INSIDE bus-worker (sole writer of bus.db) as paced micro-batches on a
low-cadence timer — a bounded row count per tick with the loop yielded between batches; never
one bulk DELETE (a long synchronous delete would re-park the exact loop task 1 unwedged).

- Channels: prune rows whose (pid, start_time) identity is provably dead AND older than a
  grace age. Switch liveness checks (prune + boot rehydrate) from pid-only to the
  (pid, start_time) pair used everywhere else, so a recycled pid no longer keeps a stale row.
- Messages: age-horizon retention that UNCONDITIONALLY preserves undelivered
  queued_for_wake rows regardless of age — selectQueuedForWake is the real durable consumer.
  First verify the planning finding that replayFromCursor/after_id is dead code (the watch
  client sends subscribe with no after_id); if confirmed dead, state that in the retention
  predicate's doc comment rather than designing protection for it.
- Bound the WAL: set journal_size_limit and a periodic PASSIVE checkpoint so pruned bytes
  actually reclaim and checkpoint windows stay short.
- If the prune predicate needs an index, bump the bus.db user_version ladder (bus.db is
  decoupled from keeper SCHEMA_VERSION — no api.py whitelist change).
- Rewrite the bus-db messages doc header from "append-only durable forensic log" to the
  retention contract (forward-facing, no history narration). The send-only/ephemeral presence
  contract is unchanged — this is pure retention/GC, so the CLAUDE.md bus line stays put.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/bus-worker.ts:645-668 — boot rehydrate (liveChannelsAtBoot + loadChannels) and the pid-only isPidAlive filter
- src/bus-db.ts:18 — the append-only doc header; :224 deleteChannel; :332 maxMessageId; :359 selectQueuedForWake; :365-391 replayFromCursor + watermark scans
- cli/bus.ts:1017 — the watch client's subscribe op (no after_id — the dead-code check)
- src/compaction.ts — the positive allow-list, paced-batch retention precedent for keeper.db

**Optional** (reference as needed):
- test/bus-db.test.ts — openBusDb(":memory:") + the bus user_version migrate ladder pattern
- src/bus-worker.ts:734-782 — flushQueue/evict (the loop-yield discipline around writes)

### Risks

- Pruning below an undelivered durable message loses a cross-agent escalation — the
  queued_for_wake preserve is unconditional, tested, and reviewed first.
- Retention timer work shares the serve loop: batch bound + yield are load-bearing, verify
  responsiveness under the task-1 harness with retention forced on.

### Test notes

bus-db unit tests: prune predicate axes (dead identity + grace age, queued_for_wake immunity,
horizon math), rehydrate bound, migrate-ladder idempotence — all on :memory:. Harness run with
retention active proves the serve path stays responsive mid-prune.

## Acceptance

- [ ] Steady-state channel rows track live agents: dead-identity rows prune within the retention window, and boot rehydrate seeds only live-identity channels
- [ ] Messages older than the retention horizon are pruned while undelivered queued_for_wake rows survive regardless of age
- [ ] No single retention tick exceeds its batch bound, and the serve path stays responsive during an active prune pass
- [ ] The WAL stays bounded (journal size limit + periodic passive checkpoint) so reclaimed rows shrink the file over time
- [ ] bun test green

## Done summary

## Evidence
