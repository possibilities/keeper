## Description

**Size:** M
**Files:** src/git-worker.ts, src/daemon.ts, src/reducer.ts, src/derivers.ts (commit-trailer parser), src/types.ts, test/git-worker.test.ts, test/reducer.test.ts

### Approach

Add `Commit` to the synthetic-event taxonomy (PascalCase, same shape as `GitSnapshot` / `GitRootDropped`). The git-worker detects a HEAD-oid delta by comparing the current `parsePorcelainV2(...)`-extracted `head_oid` against `lastHeadOidByRoot.get(root)` (new Map). On delta:

1. Shell out via existing `gitOutput(...)` helper (src/git-worker.ts:379-393):
   - `git -C <root> log <prev>..<new> --format='%H%x00%P%x00%(trailers:key=Session-Id,valueonly,only,unfold)' --no-patch -z` to enumerate commits in the delta with parent OIDs and Session-Id trailer (multiple commits if HEAD jumped by N).
   - For each commit, `git -C <root> log -1 <oid> --name-only --no-renames --first-parent --format=` for the file list.
2. Trailer parsing: split the trailer field on `\n`; take last non-empty value (handles cherry-pick stacking). Match against session-id pattern (UUID-ish). If absent or malformed → `committer_session_id = null`.
3. Post `{kind: 'commit', project_dir, commit_oid, parent_oid, files: string[], committer_session_id: string | null, committed_at_ms: number}` per commit. The worker emits one message per commit in the delta.
4. `lastHeadOidByRoot.set(root, head_oid)` after successful emission.

`src/daemon.ts:694-720` lifts the message into a synthetic `Commit` event via the existing named-binding INSERT (passes `null` for tool/Bash columns, including the new bash_mutation_* added in task 3). The reducer dispatch arm at `src/reducer.ts:3396` (alongside `GitSnapshot` / `GitRootDropped`) calls a new `foldCommit(db, event)` that:

- Parses `event.data` defensively (`extractCommit(event)` helper in derivers.ts pattern, returns null on malformed).
- For each (file_path, committer_session_id) where committer_session_id is non-null: `UPDATE file_attributions SET last_commit_at = ?, last_event_id = ?, updated_at = ? WHERE project_dir = ? AND session_id = ? AND file_path = ?`.
- For committer_session_id IS NULL (global discharge): `UPDATE file_attributions SET last_commit_at = ?, ... WHERE project_dir = ? AND file_path IN (...)` — clears every session's attribution for those files.
- All inside the open `BEGIN IMMEDIATE`. Cursor advance same transaction.

No `git log` re-shell in the reducer (producer-only liveness invariant). The reducer reads only payload fields.

The file_attributions ROWS for sessions/files not yet known (no prior mutation event) are NOT created by the discharge update — discharge only marks already-tracked attributions as cleared. A first-time mutation event creates the row (task 6 lands that path).

Boot-time bootstrap: on git-worker startup, seed `lastHeadOidByRoot` from `git status --porcelain=v2 --branch` (`parsePorcelainV2` already extracts head_oid). This avoids a spurious "delta from null → current" Commit on first boot — the worker emits nothing on bootstrap, then emits on actual HEAD changes.

### Investigation targets

**Required:**
- src/git-worker.ts:287-377 — `parsePorcelainV2`, already extracts head_oid
- src/git-worker.ts:379-393 — `gitOutput` (canonical 2s-timeout shell-out helper)
- src/git-worker.ts:417-423 — `gitCommonDirFor` (linked-worktree handling; the watcher already catches commit refs/HEAD churn)
- src/git-worker.ts:705-720 — git-common-dir parcel-watcher subscription (HEAD-oid changes already fire this; we just need to act on it differently)
- src/git-worker.ts:846-881 — DB poll + heartbeat (don't add a new poll; the existing watcher fires)
- src/daemon.ts:674-723 — `gitWorker.onmessage` lift pattern (copy for the third `msg.kind === 'commit'` branch)
- src/reducer.ts:3386-3413 — fold dispatch table (add `Commit` arm)
- src/reducer.ts:883-914 — `extractGitSnapshot` shape (template for `extractCommit`)
- src/types.ts — `Job` + sibling worker-message types
- practice-scout findings: `--format='%(trailers:key=Session-Id,valueonly,only,unfold)'` is canonical (git 2.32+); Session-Id can appear multiple times after cherry-pick (take-last policy); merge-commit file list semantics — use `--first-parent` (default reviewer mental model)

### Risks

- HEAD-oid delta with N>1 commits (push, rebase --continue from a stash, merge that landed several commits) — emit one Commit event per commit in the delta, or one event with files-union? Per-commit is more honest (each carries its own trailer); union loses trailer attribution. Go per-commit.
- Merge commits: `--name-only --first-parent` shows the diff vs first parent (matches `git merge feature → main` mental model). Octopus merges (>2 parents) — first-parent still works; subsequent parents' files attribute to discharge only via separate commits in the parents' history.
- Force-pushes / rebase: HEAD jumps to a completely different ancestry. The `<prev>..<new>` range traversal can produce "no commits" if `<new>` doesn't descend from `<prev>` — handle via fallback `git -C <root> log -1 <new> ...` (single-commit emit, treating it as a fresh HEAD).
- Initial commit (no parent): `--format='%P'` returns empty; `<prev>` doesn't exist on first boot. Handle the bootstrap-from-null case in the seed path.
- Trailer with malformed value (not a UUID-ish session-id): treat as null (global discharge). Don't crash, don't stamp a placeholder.
- Performance: each HEAD-oid change triggers up to 2 `git log` shell-outs. For a normal `commit-work` flow this is single-digit-ms. For a rebase that lands 50 commits, this is ~50 shell-outs — acceptable but worth measuring.

### Test notes

test/git-worker.test.ts: extend the existing 94-line file. Pure-function tests for `extractCommit` (defensive parse, null-on-malformed). Worker-level integration: spawn a tmp git repo + parcel-watcher harness, commit with trailer / without trailer / cherry-pick (multiple Session-Id) / amend / force-push, assert one message per commit, assert committer_session_id resolution.

test/reducer.test.ts: ≥10 fold cases for the new `Commit` arm — happy-path (single trailer commit discharges one attribution), global-discharge (null trailer clears all attributions for files), no-op (commit for file with no attribution row — must not crash), re-fold determinism (full DELETE + drain reproduces same `file_attributions.last_commit_at`), retract behavior on `GitRootDropped` (covered in task 6 but cross-link test).

## Acceptance

- [ ] `Commit` is a recognized synthetic event hook_event (PascalCase) in the reducer dispatch
- [ ] git-worker detects HEAD-oid delta per root, enumerates commits in the delta, emits one `{kind: 'commit', ...}` message per commit
- [ ] Trailer parsing handles: present-and-valid → committer_session_id set; absent → null; multiple → take-last; malformed → null
- [ ] `foldCommit` reducer arm updates `file_attributions.last_commit_at` inside the open `BEGIN IMMEDIATE` with cursor advance
- [ ] Global discharge (null committer_session_id) updates every session's attribution row for the named files
- [ ] No `git log` re-shell in the reducer (producer-only invariant preserved)
- [ ] Initial-commit / no-parent / force-push edge cases don't crash the worker
- [ ] ≥10 reducer fold tests + worker-level integration tests pass

## Done summary

## Evidence
