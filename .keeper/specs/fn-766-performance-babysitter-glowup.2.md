## Description

**Size:** M
**Files:** babysitters/performance/watch.ts, babysitters/agents/performance.md

### Approach

Five new checks, all honoring the pure-read-only invariant and the existing
check/threshold/held-gate/seen-state patterns in watch.ts:

1. duplicate-live-workers (CRITICAL, page immediately): GROUP jobs by plan_ref
   WHERE state non-terminal AND plan_ref IS NOT NULL, count rows whose pid passes
   the already-injected isPidAlive — >1 live worker on one plan_ref is the
   re-fire signature (the 2026-06-09 triple-dispatch was caught by a hand-rolled
   tripwire, not the sitter; idx_jobs_plan_ref serves the scan). This supersedes
   dup-dispatch as the load-bearing re-fire detector.
2. poison-arrivals (warning): SELECT COUNT(*) FROM dead_letters WHERE
   status='poison' — page on positive delta vs seen-state (the fn-762 poison
   parking surface). Pair with a per-name carve-out in the backstop checks: the
   events-ingest poison BackstopName pages on rescues delta >=1 (not the generic
   MISSED_WAKE_DELTA), severity warning.
3. events-log backlog (warning): event_ingest_offsets (path, inode, offset) is in
   the DB it already opens; statSync the events-log dir (resolver exported from
   src/db.ts) — page when files exist whose size exceeds their stored offset for
   >2 ticks (wedged/backlogged ingest), mirroring the dead-letter dir-count shape.
4. db-growth (info): statSync(dbPath) + dbPath+'-wal'; per-tick sample into a
   small sidecar (the backstop-baseline.json pattern: version-tagged, dev/ino
   guarded); page when WAL exceeds a generous ceiling (say 1GB) or DB grows
   anomalously fast across a day.
5. keeperd-cpu (warning, held 3 ticks): ps -o %cpu on the pid the existing pgrep
   probe (:1280) already finds; threshold ~25% held — the fn-748 144%-CPU class.
   This is the one new external input: a single ps fork per tick, read-only.

Add the new categories to the agent prompt's schema list and one-line triage
guidance each (what evidence to gather, when a finding is real vs benign).

### Investigation targets

**Required** (read before coding):
- babysitters/performance/watch.ts:497-560 (dead-letter dir-count + stuck-job shapes — the patterns to mirror), :760-830 (baseline sidecar pattern), :981-1060 (backstop cursor checks), :1280 (pgrep probe), :1230 (UDS probe)
- src/db.ts — the events-log dir resolver export; dead_letters schema (status column)
- CLAUDE.md babysitters section — state lives under babysitterStateDir(slug), never KEEPER_* paths

### Risks

- Every check must be wrapped in the existing never-throw tick discipline — a new
  check that throws kills the whole tick (the failure mode task 1's build-pin
  guards at import time, guarded here at runtime).
- No DB writes, no RPC, no synthetic events — observations + Telegram pages only.

## Acceptance

- [ ] all five checks live with held-gates/severities as specced; agent prompt schema updated
- [ ] a seeded duplicate-live-worker pair pages critical (test or manual-tick evidence)
- [ ] sitter remains read-only; full bun test green

## Done summary
Added the five fn-766 watches the post-roadmap signal landscape proved missing: duplicate-live-workers (CRITICAL, page-immediately — >1 live pid per plan_ref, the load-bearing re-fire tripwire), poison-arrivals (delta-gated) plus an events-ingest-poison backstop carve-out firing on delta>=1, events-log-backlog and keeperd-cpu (both held 3 ticks), and db-growth (WAL ceiling). All pure read-only — no DB writes, no RPC, no synthetic events; agent prompt schema + triage guidance updated; 22 new tests green.
## Evidence
