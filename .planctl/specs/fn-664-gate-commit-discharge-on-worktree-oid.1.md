## Description

**Size:** M
**Files:** src/git-worker.ts, src/derivers.ts, src/reducer.ts, src/db.ts, keeper/api.py, test/git-worker.test.ts, test/schema-version.test.ts

### Approach

Plumb the two new git facts through producer → event → projection, with NO
discharge-behavior change (purely additive; nothing reads the oids for
discharge yet — that is task `.2`).

1. **Worktree oid (GitSnapshot side).** In the git-worker's existing
   per-dirty-file `lstat`/mtime loop (~`src/git-worker.ts:57-77`), batch
   `git hash-object --stdin-paths` over the dirty files (one spawn, NOT N)
   to compute each file's worktree blob oid — WITHOUT `--no-filters` so
   clean/CRLF filters match the stored blob. Also capture `index_oid` (`hI`,
   already in the porcelain v2 record — free) and the worktree mode (`mW`).
   Add `worktree_oid`, `index_oid`, `worktree_mode` to `GitDirtyFile`
   (git-worker.ts:72) AND `ReducerDirtyFile` (reducer.ts:1047) +
   `extractGitSnapshot` (reducer.ts:1077-1136). `hash-object` failure on one
   file → that file's `worktree_oid = null` (never wedge the snapshot).
2. **Committed oid (Commit side).** Switch `commitFiles`
   (git-worker.ts:530-576) from `git log -1 <oid> --name-only` to
   `git diff-tree -r --no-commit-id <oid>` and parse the per-file new blob
   hash. Reshape `CommitPayload.files` from `string[]` to
   `Array<{path: string, blob_oid: string | null}>` and update
   `extractCommit` (derivers.ts:1182-1279) — validate each oid through the
   existing `GIT_OID_RE` (derivers.ts:1199); a bad/garbage oid → `null`.
   Update BOTH `commit.files` consumers in `foldCommit` (the per-session loop
   at reducer.ts:2282 and the global loop at :2306) for the new shape — they
   keep stamping `last_commit_at` exactly as today (no oid logic yet).
3. **Schema.** Add nullable `worktree_oid TEXT` column to `file_attributions`
   (db.ts DDL ~`:1140`). Bump `SCHEMA_VERSION` 43 → 44 (db.ts:60) — the next
   free integer at planning time; if fn-661 or another epic lands a bump
   first, rebase to the next free slot. Add `44` to keeper-py
   `SUPPORTED_SCHEMA_VERSIONS` (api.py:84-86) + a one-line comment entry in
   the SAME change. Forward-only, nullable, NO data backfill (old rows null).
4. **Stamp.** The GitSnapshot pass-1 UPSERT (reducer.ts:1760-1768) writes the
   incoming `worktree_oid` into the `file_attributions` row (additive column
   in the UPSERT). `daemon.ts:1333-1341` lifts the wider commit message
   verbatim — no change needed there.

### Investigation targets

**Required** (read before coding):
- src/git-worker.ts:57-77 — producer lstat/mtime loop (where to compute worktree oid)
- src/git-worker.ts:256-346 — parsePorcelainV2 (oid fields currently discarded; pull hI + mW; keep path-with-spaces slice math correct)
- src/git-worker.ts:530-576 — commitFiles (switch to diff-tree -r); :107/:152 wire shapes
- src/derivers.ts:1182-1279 — CommitPayload + extractCommit; :1199 GIT_OID_RE
- src/reducer.ts:1047-1136 — ReducerDirtyFile + extractGitSnapshot; :1760-1768 pass-1 UPSERT; :2282/:2306 foldCommit file loops
- src/db.ts:60 SCHEMA_VERSION, file_attributions DDL (~:1140); keeper/api.py:84-86 whitelist; test/schema-version.test.ts:56

**Optional** (reference as needed):
- src/daemon.ts:1333-1341 — commit message lift (verbatim; should need no change)

### Risks

- **hash-object cost** on dirty-heavy trees — MUST batch via `--stdin-paths`
  (one spawn), not per-file spawns; this is the producer-latency risk the
  early-proof-point is meant to catch.
- **CRLF/smudge filters** — omitting `--no-filters` is load-bearing; a raw
  hash would never equal `hH`/`hI`.
- **Migration** forward-only, nullable column, no backfill — old `file_attributions`
  rows keep `worktree_oid = null` (the oids cannot be re-derived from stored events).
- **Re-fold determinism** — oids are pure payload facts; nothing here reads OS
  state at fold time.

### Test notes

- test/git-worker.test.ts: GitSnapshot payload carries per-file `worktree_oid`
  (+ `index_oid`, `worktree_mode`); Commit payload carries per-file
  `blob_oid`; both `null` on the failure path.
- test/schema-version.test.ts green after the 43→44 bump + whitelist update.
- All existing reducer tests still pass (discharge behavior UNCHANGED in this task).

## Acceptance

- [ ] `GitSnapshot` events carry per-file `worktree_oid` (filter-correct hash-object), `index_oid`, and `worktree_mode`.
- [ ] `Commit` events carry per-file committed `blob_oid` (from `git diff-tree -r`), validated via `GIT_OID_RE`, `null` on bad/absent.
- [ ] `file_attributions.worktree_oid` column added (nullable) and populated by the GitSnapshot fold.
- [ ] `SCHEMA_VERSION` = 44 (or next free slot) and keeper-py `SUPPORTED_SCHEMA_VERSIONS` updated in the same change; schema-version test green.
- [ ] `hash-object` is batched (one spawn per snapshot), and a single-file failure yields `worktree_oid = null` without wedging the snapshot.
- [ ] Discharge behavior is UNCHANGED in this task; all existing tests pass.

## Done summary

## Evidence
