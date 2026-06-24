## Overview

keeper is the most latency-sensitive process on a shared host — it must fold every
hook event in real time — so when the host is CPU-oversubscribed it starves FIRST
and its sockets stop delivering frames within client deadlines (bus/board/autopilot
all time out). This is the latest of a multi-week run of daemon wedges (fn-888/892/921
each point-fixed an O(history)/O(board) fold); per-event fold fixes only raise the
load ceiling, never the structural fact that keeper has NO protection from host
resource exhaustion, much of it self-inflicted by agent test activity. This epic
attacks the driver on five fronts: give the canary scheduling priority, reap
agent-orphaned runaways, make the test-gate un-floodable, fix the leak-prone test
fixture, defuse the next O(history) fold, and bound the event-log's unbounded growth.

## Quick commands

- `ps -o pid,nice,comm -p $(pgrep -f 'daemon.ts')` — keeperd runs at the elevated Nice after T1
- `bun run test:full` — refold-equivalence + reaper + compaction suites green
- `du -h ~/.local/state/keeper/keeper.db` — bounded after T5 (was 1.16GB / 4.4M events)

## Acceptance

- [ ] keeperd is no longer scheduled as a throttled Background job; it keeps folding under host contention.
- [ ] Agent-orphaned runaway processes (orphaned bun test-worker trees, infinite-loop shell harnesses, leaked test fixtures) are reaped; legitimate work and keeper's own tree are never killed.
- [ ] A raw `bun test` can no longer oversubscribe the shared host; the leak-prone flock_peer fixture self-terminates.
- [ ] No fold's per-event cost scales with session history or board size (computeMonitors bounded); keeper.db row growth is bounded with re-fold determinism preserved.

## Early proof point

Task that proves the approach: `.4` (computeMonitors fold bound). It proves a fold's
O(history) cost can be bounded WITHOUT changing the projection and WITHOUT breaking
byte-identical re-fold — the exact property `.5` (retention DELETE) depends on. If `.4`
can't bound the fold while keeping the monitor set identical, `.5`'s determinism proof
is unlikely to hold either — surface that before attempting the physical delete.

## References

- Incident: ~28 orphaned `while :; do :; done` CPU-saturation test harnesses (fn-931 de-flake work) + 2 leaked `flock_peer.ts` fixtures pegged the host to load ~188 on 10 cores; keeperd starved to 0.9% CPU; bus/board/autopilot timed out.
- Lineage: fn-888 (syncPlanLinks O(board)), fn-892 (git pass1 O(history) → incremental memo — the model for T4), fn-921 (subagent_invocations recencyBound + git seed watchdog).
- Soft coordination (advisory, NOT a hard dep): fn-930 reads `openDb` read-only in a new worker; this epic bumps SCHEMA_VERSION (T5). No write-file conflict; the schema bump is a serialization point — land T5's `src/db.ts`/`keeper/api.py` change cleanly relative to fn-930.4/.5 (which only read the schema).
- Sibling fn-933 (bus sender misattribution) is unrelated — shares only a READ of `readOsStartTime`.

## Best practices

- **macOS daemon priority:** `ProcessType=Standard` + `Nice=-5` is the right first choice for a latency-sensitive daemon; NOT `Interactive` (removes all throttling, can starve the human's foreground work), NOT `Background` (the throttled class it's wrongly in now). Set in the plist, never `setpriority()` at runtime. [launchd.plist(5)]
- **Process identity for reaping:** fingerprint `(pid, start_tvsec, uid, exe_path)` — never a bare pid (recycled pid is an LPE vector); gate PPID=1 + age + exe-signature + uid-scope TOGETHER; `proc_pidinfo` 0/partial for another user → can't-confirm-don't-kill. [htop #1441, "Don't Trust the PID"]
- **SQLite log compaction:** batched DELETE (500–5000 rows/txn) + `wal_checkpoint` after batches + `incremental_vacuum`; DELETE alone doesn't shrink the file; run compaction in the daemon's own writer process (a separate process + long reader pins the WAL). [sqlite.org/wal.html]

## Docs gaps

- **plist/arthack.keeperd.plist**: inline comment on the ProcessType/Nice scheduling-priority choice (T1).
- **README.md**: LaunchAgent install note (priority), reaper taxonomy (two arms → add the orphan arm), config reference (`disable_orphan_reap` sibling to `disable_autoclose`), compaction section (the new DELETE pass) (T1/T2/T5).
- **CLAUDE.md**: "three distinct reapers" → four; the O(history) invariant index gains `computeMonitors`; the test-gate raw-`bun test` warning updated to the current enforcement (T2/T4/T3).
- **keeper/api.py**: `SUPPORTED_SCHEMA_VERSIONS` bump in the SAME commit as T5's SCHEMA_VERSION bump (enforced by test/schema-version.test.ts).
