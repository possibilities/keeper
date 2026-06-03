## Overview

Today keeper's git-worker only watches git roots that contain a `.planctl/`
directory (`gitRootFor`, src/git-worker.ts:510). Unwatched repos never emit a
`GitSnapshot`, so the reducer's attribution pass never runs, `file_attributions`
stays empty, `keeper/api.py::get_session_dirty_files` returns nothing for the cwd
repo, and `jobctl commit-work` is a silent no-op in any repo without `.planctl/`
(reproduced live in /Users/mike/code/planctl). This epic widens the watch gate to
`.planctl present || working tree dirty || ahead of upstream > 0`, recomputed
dynamically each reconcile, so a repo joins the watched set when it has
uncommitted or unpushed work and drops when it goes clean-and-pushed. The watched
set stays ≈ the active set, so keeperd's load stays at today's level. End state:
`commit-work`, `show-session-files`, `session-state`, and the board's attribution
pipeline all work in any dirty/unpushed repo with zero changes to keeper.api or
jobctl — the producer-side gate is the only change, and retroactive attribution
(reducer Pass-1 scans the persisted event log) lights up already-edited files the
moment a repo first subscribes.

## Quick commands

- End-to-end: in a dirty non-`.planctl` repo with an active session, `jobctl commit-work --preview-files` returns the session-touched files (was `{"files":[]}` before).
- Lint/type/test: `cd /Users/mike/code/keeper && bun run lint && bun run typecheck && bun run test` (mirror package.json script names; confirm in task).
- Targeted: `bun test test/git-worker.test.ts test/reducer.test.ts`

## Acceptance

- [ ] A non-`.planctl` repo that is working-tree dirty OR ahead of upstream gets watched and produces `file_attributions` rows for the editing session.
- [ ] A non-`.planctl` repo that is clean-and-pushed is NOT watched (drops after a cooling dwell once it becomes clean+pushed).
- [ ] `.planctl` repos retain today's always-watched behavior (watched even when clean) and incur no probe spawn (short-circuit).
- [ ] keeperd steady-state load is unchanged: per-reconcile probe spawns ≈ 0 thanks to TTL memo + bounded candidate set.
- [ ] Re-fold determinism holds: the same event log re-folds byte-identically regardless of watch-membership history (no membership/TTL state leaks into any emitted event).
- [ ] `jobctl commit-work --preview-files` works end-to-end in a dirty non-`.planctl` repo.

## Early proof point

Task that proves the approach: `<epic>.1` (the gate + probe + reconcile integration). If it fails — e.g. spawnSync probing stalls the worker thread or re-fold determinism breaks — fall back to read-side on-demand attribution in `keeper/api.py` (the "Option B" alternative considered below), which needs no producer change.

## References

- Root-cause chain (this session): `gitRootFor` .planctl gate (src/git-worker.ts:510) → no GitSnapshot → no reducer attribution pass → empty `file_attributions` → `get_session_dirty_files` empty (keeper/api.py:370) → `jobctl commit-work` no-op.
- Candidate discovery: `discoverProjectRoots` (src/git-worker.ts:1029) builds candidates from `SELECT DISTINCT cwd FROM jobs` (:1035) + epic/task dirs; `gitRootFor` filters on `.planctl`.
- Reconcile cadence: DB poll `DB_POLL_MS=100` (:293/:1699) on `PRAGMA data_version` bump + `HEARTBEAT_MS=60_000` (:295/:1715); `subscribeRoot` fires an immediate `emitSnapshot` (:1571); `reconcileRoots` diffs desired vs current (:1624).
- Drop path: `unsubscribeRoot` posts `git-root-dropped` tombstone → daemon synthesizes `GitRootDropped` (src/daemon.ts) → `reducer.retractGitStatus` DELETEs `file_attributions`+`git_status` for project_dir (src/reducer.ts:2449).
- Probe building blocks: `gitOutput` spawn wrapper w/ `GIT_TIMEOUT_MS=2000` (:488), `parseBranchAheadBehind` (:361), `parsePorcelainV2` (exported, :372), `readStatus` ahead/behind (:485).
- Epic-scout: no inter-epic deps/overlaps; only open epic fn-689 (restore-worker) is file-disjoint.
- Alternative considered & rejected: read-side on-demand attribution in `keeper/api.py` (Option B) — simpler/race-free for commit-work alone but gives non-planctl repos none of the board pipeline; rejected in favor of the dynamic producer-side watch for full board parity. Retained as the task .1 fallback.

## Docs gaps

- **src/git-worker.ts** module header (1-29), `gitRootFor` comment (510), tombstone JSDoc (151-161): "planctl-backed" framing becomes stale.
- **src/types.ts** GitStatus/GitSnapshot JSDoc (1213-1222): rows no longer only from planctl-backed worktrees.
- **src/reducer.ts** `retractGitStatus` JSDoc (2420-2445): drop trigger is now "no longer satisfies the watch gate", not ".planctl removed".
- **src/daemon.ts** worker comment (48), **src/collections.ts** git descriptor (374): "planctl-backed" label.
- **README.md** lines 119, 841-843, 1781: `git` collection / client / projection descriptions say "planctl-backed".

## Best practices

- **One combined probe:** `git status --porcelain=v2 --branch` yields dirty (any non-header record) AND ahead (`# branch.ab +N`) in a single spawn — no separate `rev-list`.
- **Use `-unormal` (default), not `-uall`** for the probe: the full untracked descent is the perf cliff; `-unormal` is sufficient for an is-dirty verdict.
- **Don't `git fetch` in the probe** — read local refs only; "ahead" = local HEAD ahead of local tracking branch.
- **Hysteresis to prevent churn:** a dwell before unsubscribe stops dirty→subscribe→clean→unsubscribe→dirty oscillation and the fseventsd-state degradation it causes.
- **Bounded watch set is the FSEvents safety mechanism:** hundreds of concurrent FSEvents streams degrade `fseventsd` silently; cap simultaneous subscribes and never balloon the set on a full sweep.
- **Per-root verdict TTL must be separate from the daemon-permanent `cwdRootCache`** (which caches cwd→toplevel forever); prune the TTL map off the hot tick.
