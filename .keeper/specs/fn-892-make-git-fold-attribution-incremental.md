## Overview

The git fold's explicit-attribution pass (`buildExplicitAttribHoist`, src/reducer.ts:1279)
is the dominant steady-state reducer cost — ~80% of all fold CPU, avg ~14.5s/fold, with
single folds reaching tens of seconds. On every live `GitSnapshot` fold it runs two
UNBOUNDED full-history scans of the `events` table (a bash exact-match scan and a
git-rm/git-mv deletion scan), re-reading and re-parsing every bash-mutation row ever
written. Cost grows monotonically with log size. This epic makes that pass incremental via
an in-process memo keyed by `Database` connection: each fold scans only the rows newer than
the memo's high-water `id` and appends to the cached parsed structures. End state: pass-1
cost is O(rows since last fold), independent of history length, with byte-identical
`file_attributions` output preserved. fn-888 made the analogous planctl/job_links fold
constant-bounded; this is the same move for the git surface.

## Quick commands

- `bun test test/refold-equivalence.test.ts test/git-live-projection.test.ts` — re-fold byte-identity + live-surface folds
- `bun run test:full` — mandatory full tier (touches reducer/db/git fold paths)
- `grep -E 'gitfold-breakdown' ~/.local/state/keeper/server.stderr | grep -oE 'p1_bash_rows=[0-9]+' | sort -t= -k2 -n | tail` — confirm per-fold delta is small, not full-history

## Acceptance

- [ ] Both pass-1 scans in `buildExplicitAttribHoist` are incremental (scan only `id > memo.maxId`), `computeRepoBashWindows` (pass2) untouched
- [ ] Re-fold produces byte-identical `file_attributions` (proven via `test/refold-equivalence.test.ts` with the git floor lowered to 0)
- [ ] `[gitfold-breakdown]` `pass1_explicit` / `p1_bash_rows` collapse to per-fold delta in steady state
- [ ] No schema bump, no migration, no new projection; fold stays pure (no clock/env/fs) and never throws
- [ ] CLAUDE.md/README time-bomb framing corrected to name the pass-1 scans; `SLOW_FOLD_INVESTIGATION.md` retired

## Early proof point

Task that proves the approach: `.1` — the incremental memo plus the re-fold byte-identity
assertion. If `refold-equivalence` cannot be made to pass with the memo, the approach is
wrong (the memo is not a faithful superset of the full scan) and we fall back to a
project-dir/floor-scoped SQL bound with an explicit boot-seed full-fidelity path.

## References

- `buildExplicitAttribHoist` src/reducer.ts:1279-1398; types :1245-1271; called from `projectGitStatus` :1724-1786 (after the skip-floor gate :1731); `[gitfold-breakdown]` emit :2105-2133.
- Bounding reference pattern (do NOT change): `computeRepoBashWindows` src/reducer.ts:1599-1644 (MAX_BASH_WINDOW_SEC bound).
- Incremental-fold precedent on this same live-only surface: `mergeJobLinkSlice` src/reducer.ts:5145 (fn-888).
- Covering index already present: `idx_events_bash_attr` src/db.ts:1151 (partial on `bash_mutation_kind IS NOT NULL`) — the `id > maxId` scan still uses it; EXPLAIN precedent test/reducer-projections.test.ts:4659.
- In-process memo precedent (house style): src/server-worker.ts:430-453.
- Overlap (advisory, NOT a hard dep): fn-889 (retire planctl name) runs a repo-wide AST codemod over `src/reducer.ts` renaming `planctl_*` breakdown symbols. Different functions from the git fold, so conflict risk is low; whichever lands first, the other rebases. The perf patch is small and surgical — rebase it onto the codemod if fn-889 lands first.

## Docs gaps

- **CLAUDE.md / AGENTS.md** (~88-98): the time-bomb invariant names `computeRepoBashWindows` as the O(history) example — now imprecise; revise to name the pass-1 scans and that they are memoized. The fn-888/`syncPlanLinks` half of that sentence stays accurate.
- **README.md** (~1763-1790, ~570-578): the "dominant GitSnapshot cost is pass 1" claim becomes stale; revise to present-tense memo description.
- **SLOW_FOLD_INVESTIGATION.md** (repo root, untracked): its open questions are answered by this change — delete it (or replace with a one-line closure).

## Best practices

- **Strict `id > maxId`, never `>=`:** re-processing the watermark row re-applies the last event. [SQLite watermark scan]
- **Watermark on `id` (insertion order), winner re-evaluated per key on `(ts, id)`:** id order != ts order, so the memo stays correct only because attribution is newest-wins re-evaluated, not because new rows beat old. [SQLite AUTOINCREMENT]
- **Retention NULLs bodies, not rows:** an incremental scan crossing a body-nulled row still sees it and must advance `maxId` past it — never add `if(!row.data) continue`. The fold reads only keep-set columns (`bash_mutation_kind`, `bash_mutation_targets`), which retention never sheds. [src/compaction.ts]
- **WeakMap<Database> is test-safe only with a fresh DB per test:** a `Database` reused across cases carries a warm cache and diverges from a cold rescan; ensure git-fold tests use `freshDb`/`freshMemDb` or clear the entry.
