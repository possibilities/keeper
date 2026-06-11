## Description

**Size:** S
**Files:** src/daemon.ts, README.md, CLAUDE.md, test/daemon.test.ts

### Approach

In withBootDrainCheckpointTuning's finally (daemon.ts:314), change
wal_checkpoint(PASSIVE) → wal_checkpoint(TRUNCATE) and rewrite the
function's doc comment (:300-304, which currently asserts PASSIVE):
at this call site only main's writer connection exists inside the
daemon (workers spawn later, :1451+), TRUNCATE empties the WAL so
every worker's first open reads the main file with no WAL-scan/shm
-recovery path, and PRAGMA wal_checkpoint returns a busy-status row
rather than throwing — under an attached external reader (keeper-py,
the performance sitter, dashctl) the worst case is a busy_timeout-
bounded pause degrading to PASSIVE semantics, after which boot
proceeds. Steady-state checkpoints MUST stay PASSIVE: daemon.ts
:3148/:3172 and compaction.ts :74-75/:186 untouched. Docs per epic
Docs gaps: rewrite README.md:105-108 (the hook-INSERT-starvation
justification is stale since fn-736 — the hook no longer writes the
DB; explain the boot-TRUNCATE/steady-PASSIVE split) and add the two
Worker-contract bullets to CLAUDE.md (prepareStmts:false when no
stmts used; bounded initial-open retry), matching the existing
bold-keyword single-line bullet format.

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:160-170,300-317 — WAL_AUTOCHECKPOINT_PAGES + withBootDrainCheckpointTuning (the edit site and the comment to rewrite)
- src/daemon.ts:1219-1322,1451 — the boot call site proving no workers exist yet
- src/daemon.ts:3148,3172 + src/compaction.ts:74-75,186 — the PASSIVE sites that must NOT change
- README.md:95-108 — the stale checkpoint narrative to revise in place

### Risks

- Flipping any steady-state checkpoint to TRUNCATE starves concurrent readers/writers — the change is exactly one line at the boot finally
- A test asserting on WAL file size/presence after boot may need updating — check daemon.test.ts for WAL assertions

### Test notes

daemon.test.ts: after an in-process daemon boots (harness), assert the -wal file is empty/absent before workers' first query lands (or assert the checkpoint ran via PRAGMA wal_checkpoint result). Existing suites green; bun run test:full mandatory.

## Acceptance

- [ ] Boot finally is TRUNCATE with the rewritten rationale comment; all steady-state checkpoints remain PASSIVE (grep-verified)
- [ ] README checkpoint narrative rewritten in place; CLAUDE.md worker-contract bullets added
- [ ] bun run test:full green

## Done summary
Flipped the boot-drain finally checkpoint from PASSIVE to TRUNCATE (boot runs pre-worker-spawn so nothing to block on; empties the WAL so every worker's first open skips WAL-scan/-shm recovery). Steady-state checkpoints stay PASSIVE; README narrative + CLAUDE.md worker-contract bullets + checkpoint-mode test updated.
## Evidence
