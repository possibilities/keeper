## Description

**Size:** M
**Files:** src/daemon.ts, src/server-worker.ts, src/compaction.ts, test/daemon.test.ts

### Approach

Debug-first: reproduce and instrument before fixing. The failure is a fresh subscribe connection receiving no first frame within seconds while the control RPC stays responsive — intermittent, spanning daemon restarts, on a 1.7G / million-row-events database. Instrument the serve path's first-snapshot assembly and the daemon's periodic passes (retention every five minutes, any WAL checkpoint, boot seeding, other sweeps) with timing evidence sufficient to name which one holds the loop while a fresh connection waits. Then fix that specific blocker in its own idiom — bounding an unbounded snapshot read with the established recency bound, moving a blocking pass off the serve path, or chunking it — never a broad rewrite. The events-table mass is a fact to be indifferent to, not to shrink: retained bodies are a deliberate capture surface. Finish with a regression guard: a test (or a bounded in-daemon self-check) that fails when first-frame assembly can be starved past the default snapshot window by a periodic pass.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts — the retention pass scheduling (five-minute interval) and every other setInterval/periodic sweep sharing the loop with the serve path; the serve-liveness watchdog (why a multi-second stall does not trip it)
- src/compaction.ts — retainColdPayloads cost shape against ~1.07M rows / ~486k retained bodies
- src/server-worker.ts (or wherever subscribe first-snapshot assembly lives) — what a fresh connection reads before frame 1 and whether any collection read lacks its recency bound
- The reproduction numbers: default-window snapshot timeouts recur while control RPC answers; one 45s-window success; then a 0.5s first frame minutes later — intermittency is the fingerprint to explain, not steady slowness

### Risks

- The stall may live in bun:sqlite WAL behavior rather than keeper code — if so, the fix is checkpoint scheduling, and the evidence must show it before any pragma changes land

### Test notes

Fast-tier where the seam allows (pure timing harness over the pass + a stubbed serve read); if only observable against a big real DB, a bounded slow-tier case with a synthetically grown table.

## Acceptance

- [ ] Instrumented evidence names the component that starves first-frame delivery, and the fix addresses that component specifically
- [ ] Repeated default-window board snapshots deliver frame 1 across a span covering the daemon's periodic passes on a production-scale database
- [ ] A regression guard fails if first-frame assembly can again be starved past the default snapshot window; full fast suite green

## Done summary
Debug-first root cause: the board first-frame stall was NOT serve-loop/retention/WAL starvation against the grown DB but an oversized git-collection NDJSON frame. A worktree with thousands of dirty files renders a git_status.dirty_files array past 1 MiB; the subscribe first-frame ships the git result as ONE NDJSON line, and the viewer's parser rejects any line over MAX_LINE_LENGTH (1 MiB, src/protocol.ts) and reconnect-loops, so no first frame ever lands. This explains the intermittency fingerprint: the stall tracks worktree dirty-file count, not DB size, so it recurs across restarts and vanishes once the tree cleans. Fix (src/reducer.ts): cap the MATERIALIZED dirty_files mirror at GIT_STATUS_DIRTY_FILES_WIRE_CAP=200 at the FOLD, keeping each worktree's serialized contribution ~50 KB so the served frame is always deliverable. dirty_count stays EXACT and pass-4 per-job rollups fold from the FULL snapshot (not the bounded array), so no board scalar or dispatch decision changes; readiness's per-file consumer is retained-but-unread.
## Evidence
- Commits: 922bc117
- Tests: test/daemon.test.ts — git first-frame: a worktree with thousands of dirty files serves a git snapshot frame under the NDJSON line cap, dirty_count stays exact (asserts dirty_files array caps at GIT_STATUS_DIRTY_FILES_WIRE_CAP=200, dirty_count==N exact, served frame JSON length < MAX_LINE_LENGTH, guards-the-guard via perEntryBytes*N > MAX_LINE_LENGTH)