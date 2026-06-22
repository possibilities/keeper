## Description

**Size:** M
**Files:** src/reducer.ts, test/refold-equivalence.test.ts, test/reducer-lifecycle.test.ts, CLAUDE.md, README.md, SLOW_FOLD_INVESTIGATION.md

### Approach

Replace the two unbounded full-history scans in `buildExplicitAttribHoist`
(src/reducer.ts:1304-1309 bash exact-match; :1355-1359 git-rm/git-mv deletion) with an
in-process memo of the already-parsed structures (`bashByToken: Map<string,
BashMutationRow[]>` and `deletionRows: DeletionMutationRow[]`, types at :1245-1271). Hang
a `{maxId, bashByToken, deletionRows}` value off a module-level `WeakMap<Database, …>`.
Per fold: scan only `bash_mutation_kind IS NOT NULL AND id > memo.maxId` (and the
deletion subset) ORDER BY id, parse + append into the cached structures, then set `maxId`
to the highest scanned id. On a cold entry (no memo for this `Database`), the first scan
is `id > 0` = the whole history once, which preserves boot-seed full fidelity for free.
Keep the existing safe-fold (`continue` on malformed JSON at :1324/:1376) AND still
advance `maxId` past malformed rows so the fold never throws and never stalls the
watermark. Do NOT touch `computeRepoBashWindows` (pass2) — it is already bounded.

This is the live-only / charter-excluded git surface (git_status, file_attributions),
so in-memory append is acceptable — but the persisted `file_attributions` projection must
stay order-insensitive (it already is: newest-wins UPSERT by last_mutation_at on (ts,id)).
No schema bump, no migration, no new projection, no new index (`idx_events_bash_attr`
already covers the `id > maxId` scan).

The deletion-MATCH triple-loop (:1509-1523, O(nfiles x ndeletionRows x ntokens)) stays
O(history) in `deletionRows` even after the scan is memoized; git-rm/git-mv are sparse so
this is second-order — out of scope for this task unless trivially co-located, note as a
future follow-up.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:1279-1398 — `buildExplicitAttribHoist`, the two scans, parsed structures, safe-fold
- src/reducer.ts:1245-1271 — `BashMutationRow` / `DeletionMutationRow` / `ExplicitAttribHoist` types
- src/reducer.ts:1724-1786 — `projectGitStatus`, skip-floor gate (:1731), hoist build site (:1786)
- src/reducer.ts:2105-2133 — `[gitfold-breakdown]` emit (pass1_explicit, p1_bash_rows, p1_del_rows accounting)
- test/refold-equivalence.test.ts — byte-identity harness; lowers git floor to 0 (~:807) then ORDER BY snapshot of file_attributions (~:749) across two re-folds

**Optional** (reference as needed):
- src/reducer.ts:1599-1644 — `computeRepoBashWindows` bounding pattern (rationale comment style to mirror)
- src/reducer.ts:5145 — `mergeJobLinkSlice` (fn-888 incremental-fold precedent, same surface)
- src/db.ts:1151 — `idx_events_bash_attr` partial covering index
- src/server-worker.ts:430-453 — in-process per-instance memo precedent (doc-comment style)
- test/reducer-lifecycle.test.ts:140, :1379-1440 — `insertEvent` helper + existing attribution tests
- test/reducer-projections.test.ts:4659 — EXPLAIN-QUERY-PLAN index assertion precedent

### Risks

- **Re-fold byte-identity** is the load-bearing risk: the memo MUST be a faithful superset
  of the full scan. Because the log below head is append-only (rows never deleted;
  retention only NULLs fold-unread bodies) and attribution is newest-wins on (ts,id), an
  incremental append equals a full rescan — but this must be PROVEN, not assumed.
- **WeakMap test isolation:** a `Database` reused across test cases carries a warm cache;
  the warm path must equal a cold rescan. Tests must use fresh DBs (freshDb/freshMemDb) or
  clear the memo entry.
- **Watermark correctness:** strict `id > maxId` (not `>=`); advance `maxId` even past
  malformed/body-nulled rows.

### Test notes

- Extend `test/refold-equivalence.test.ts` (or a sibling) to assert byte-identical
  `file_attributions` with the memo active across two from-scratch re-folds (floor lowered to 0).
- Add a warm-vs-cold test: build the hoist incrementally across several GitSnapshots, then
  compare to a from-scratch full scan on the same data — must be equal.
- Confirm a steady-state fold's `p1_bash_rows` reflects only the delta (optionally an
  EXPLAIN assertion that the incremental scan uses `idx_events_bash_attr`).
- `bun run test:full` must be green (mandatory tier for reducer/git fold changes).

## Acceptance

- [ ] `buildExplicitAttribHoist` maintains a `WeakMap<Database, {maxId, bashByToken, deletionRows}>` memo; both pass-1 scans are incremental (`id > maxId`), appending to cached structures and bumping `maxId`
- [ ] `computeRepoBashWindows` (pass2) is unchanged
- [ ] Malformed `bash_mutation_targets` still safe-folds via `continue` AND still advances `maxId`; the fold never throws and reads no clock/env/fs
- [ ] `test/refold-equivalence.test.ts` proves byte-identical `file_attributions` across two from-scratch re-folds with the memo active (floor lowered to 0)
- [ ] A warm-cache-vs-cold-rescan test proves the incremental path equals a full scan on the same data
- [ ] Steady-state `[gitfold-breakdown]` `p1_bash_rows`/`pass1_explicit` reflect the per-fold delta, not full history
- [ ] CLAUDE.md/AGENTS.md + README.md time-bomb / pass-1 framing corrected to name the pass-1 scans and the memo (forward-facing, present tense)
- [ ] `SLOW_FOLD_INVESTIGATION.md` removed (resolved by this change)
- [ ] `bun run test:full` green

## Done summary

## Evidence
