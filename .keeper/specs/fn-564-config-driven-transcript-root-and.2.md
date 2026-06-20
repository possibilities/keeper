## Description

**Size:** M
**Files:** src/transcript-worker.ts, test/transcript-worker.test.ts, test/integration.test.ts, CLAUDE.md

### Approach

Add a startup current-title fold so a rename set while the daemon was down still
lands. After `seedFromDb` seeds the change-gate AND after `subscribe()` resolves
(inside the `.then((sub) => ...)` block, guarded by the existing `existsSync` root
check and a `shuttingDown` check — mirror plan-worker's scanRoot placement at
plan-worker.ts:599-602), run a one-shot scan.

Scope the scan to live jobs via `jobs.transcript_path` (read on the worker's
existing read-only connection) — NOT a recursive enumeration of the watch root.
Rationale: a transcript title only folds onto an existing `jobs` row (boot drain
has already created them before this worker spawns), and `jobs.transcript_path`
(schema v5) points at the session's actual transcript file — so this scopes to
exactly the files that matter, avoids recursing the deeply-nested
`~/.claude/projects/<project>/<session>.jsonl` tree, skips thousands of dead
historical transcripts, and reads the real per-session file even in multi-profile
setups. For each job with a non-null `transcript_path`: synchronously read the file
from offset 0 to a once-snapshotted size in bounded 64 KiB chunks (REUSE the
existing consume / StringDecoder / partial-line / malformed-skip machinery — don't
hand-roll a second reader), track the LAST `custom-title` for that session, and emit
it ONCE via the existing change-gate (`lastEmitted`). A title already folded (seeded
by `seedFromDb`) is suppressed; the reducer's same-priority-same-value no-op makes
any leak harmless. Per-file try/catch skip-and-log; the scan is non-fatal and must
NOT trip the subscribe `.catch` → `fatalExit`.

Because the scan runs synchronously to completion before any async watcher callback
fires, there is no race with the live tail and no shared-PathState requirement — the
live `onChange` continues to auto-register watched-root paths at EOF as today, and
the change-gate dedups across both. The worker stays read-only; main remains the
sole writer of synthetic `TranscriptTitle` events.

### Investigation targets

**Required** (read before coding):
- src/transcript-worker.ts:160-351 — TranscriptLineStream (register EOF-anchor 183-198, onChange/consume/dispatchLine read+parse machinery to reuse, `lastEmitted` change-gate at 162)
- src/transcript-worker.ts:368-377 — seedFromDb (seeds change-gate from jobs.title WHERE title_source='transcript'); the scan must run AFTER this
- src/transcript-worker.ts:399-521 — main() boot order (seed → subscribe → .then), missing-root tolerance (458-466), shuttingDown guard (508)
- src/plan-worker.ts:400-421 + 592-603 — scanRoot boot-scan precedent + its placement inside the subscribe .then, with per-file skip-and-log
- test/transcript-worker.test.ts:55-209 — pure TranscriptLineStream unit tests (seedLastEmitted at 150-171 is the change-gate precedent)
- test/plan-worker.test.ts:257-297 — seedFromDb + onChange suppression test shape

**Optional** (reference as needed):
- test/integration.test.ts:491-584 — transcript e2e (add a "title present before daemon boot → folded at startup" case)
- src/types.ts — Job.transcript_path shape

### Risks

- Multi-rename file: emit only the CURRENT (last) `custom-title` per file at startup — track the last match during the scan and emit once, to avoid event-log churn from intermediate historical renames.
- Dedup correctness is load-bearing: the scan MUST run after `seedFromDb` so an already-folded title is suppressed; otherwise every restart re-emits a `TranscriptTitle` event for an unchanged title (event-log bloat, though reducer-idempotent). Make "no new event on restart for an unchanged title" an explicit test.
- Don't `readFileSync` the whole transcript (large files) — bounded chunks; the `line.includes("custom-title")` pre-filter keeps the scan mostly substring search.
- Jobs with NULL `transcript_path` (old pre-v5 rows) can't be scanned — acceptable; document the limitation.
- Intentional asymmetry: the startup scan reads `jobs.transcript_path` (the real per-session file, possibly outside the single configured watch root in multi-profile setups); the live watcher only sees the configured root. The scan strictly helps; multi-root live watching is out of scope.

### Test notes

- Pure-core test: a TranscriptLineStream scan of an existing file containing a `custom-title` (with NO further appends) emits the title once; a second scan after seeding `lastEmitted` with that title suppresses it.
- Restart-determinism test: `seedFromDb(title)` then scan the same file → no emit (already folded).
- Integration: write a transcript with a `custom-title` BEFORE spawning the daemon → assert `jobs.title` folds to it at startup (the exact bug this fixes).

## Acceptance

- [ ] On boot, after `seedFromDb` + subscribe, the worker folds the current `custom-title` for each job with a non-null `transcript_path`, scoped via `jobs.transcript_path` (no recursive watch-root enumeration)
- [ ] A title already folded (`title_source='transcript'`, seeded into the change-gate) is NOT re-emitted on restart — no duplicate `TranscriptTitle` event for an unchanged title
- [ ] Only the current/last `custom-title` per file is emitted at startup (no churn from intermediate renames)
- [ ] The scan reuses the existing bounded-chunk / decoder / partial-line / malformed-skip read path, snapshots size once, and is per-file non-fatal (skip-and-log, never trips fatalExit)
- [ ] Worker stays read-only (main remains sole writer of synthetic `TranscriptTitle` events); re-fold determinism preserved
- [ ] New pure-core + restart-determinism unit tests and an integration "rename-while-down → folded at boot" test; full `bun test --isolate` green
- [ ] CLAUDE.md state-machine + worker-contract sections note the startup-fold path

## Done summary
Added a startup current-title fold (scanJobsForTitles + TranscriptLineStream.scanFile) scoped via jobs.transcript_path, so a custom-title set while keeperd was down folds at boot; runs after seedFromDb so the change-gate suppresses already-folded titles (no duplicate event on restart).
## Evidence
