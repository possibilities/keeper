## Description

**Size:** M
**Files:** scripts/git.ts, scripts/board.ts, scripts/autopilot.ts, test for the affected pure-function helpers if any

### Approach

**scripts/git.ts (renderRowBlocks at :75-135)**: rewrite the row-block layout from the old per-job nesting to file-centric. New shape per dirty file:

```
(project) [branch +ahead -behind] dirty=N orphan=M unattributed=K
  path/to/file.ts [M ] tool@sess-a, bash@sess-b, inferred@sess-c
    ↳ planctl: <orig_path if rename>
  path/to/other.ts [??] tool@sess-d
  ...
```

The `[M ]`/`[??]`/etc. is the porcelain xy code. Source-badged attribution list: `tool` (Write/Edit/MultiEdit/NotebookEdit), `bash` (deriver-stamped), `inferred` (mtime bracket-matched). Multi-attribution shows all sessions inline, comma-separated, sorted by `last_touch_at` desc. Truly-orphan files (no attribution at all) render as `<orphan>` in the attribution slot.

The old per-job grouping (`for job of jobs[]`) goes away — that data is recoverable from the per-file attributions, but the renderer doesn't show it that way anymore. Keep `unpushed` line (ahead count) and `git_orphan_count` summary at the project level.

**scripts/board.ts + scripts/autopilot.ts**: column-rename only. Find every `git_orphan_count` read site, swap to `git_unattributed_to_live_count`. Don't change reason-kind strings (`git-uncommitted`, `git-orphans`) — those stay (per task 7). Autopilot simulator zero-on-flip path at autopilot.ts:593, :634 zeros BOTH new columns (`git_dirty_count`, `git_unattributed_to_live_count`, AND new `git_orphan_count` — three columns total) on a working→ended sim transition.

Type updates in src/collections.ts GIT_DESCRIPTOR (:285-316) if needed — the `dirty_files` jsonColumn entry is unchanged, but the wire shape it carries is widened. Same for `JOBS_DESCRIPTOR` (:87-142).

### Investigation targets

**Required:**
- scripts/git.ts:75-135 — `renderRowBlocks` (the rewrite seam)
- scripts/git.ts:46-64 — `actor` / `seg` / `statusLine` helpers (reusable for the new layout)
- scripts/autopilot.ts:230, :238, :449 — reason-kind enumeration consumers (DO NOT change reason names, just column references)
- scripts/autopilot.ts:532-546 — predicate 6.5 reason-source filter in autopilot's informational pre-pass
- scripts/autopilot.ts:593, :634 — zero-on-flip sim sites (update for the three new/renamed columns)
- scripts/board.ts — search for any `git_orphan_count` reference + update
- src/collections.ts:87-142 — JOBS_DESCRIPTOR column list (add/rename)
- src/collections.ts:285-316 — GIT_DESCRIPTOR (jsonColumns stay; semantics change)

### Risks

- The new layout is dense. A worktree with 50 dirty files + 3-way attribution per file produces 50 lines × ~80 chars. Cap individual file lines at ~100 chars (truncate attribution list with `+N more`) if visually painful — defer empirical check to the worker.
- Truly-orphan files showing as `<orphan>` could be alarming for the human if it fires on routine files (lockfiles, generated artifacts). The bash mutation deriver (task 3) should catch most cases; inferred attribution (task 6) should catch the rest. If truly-orphan rate is high in practice, that's a signal we missed a pattern in the deriver, not a renderer bug.
- Autopilot simulator (autopilot.ts:593, :634) zeros multiple columns now. Easy to miss one. Add an explicit assertion in the simulator's `dirty = false` check that all three columns are zero post-flip.

### Test notes

Add a small test for `renderRowBlocks` (if not already present) using a synthetic row payload with multi-attribution. Cover: zero dirty (empty block), single-attribution per file, multi-attribution per file, truly-orphan file, rename with orig_path. Existing autopilot tests get column-name updates.

## Acceptance

- [ ] scripts/git.ts renders file-centric layout with source-badged multi-attribution (`tool@<session>, bash@<session>, inferred@<session>`)
- [ ] Truly-orphan files render as `<orphan>` in the attribution slot
- [ ] scripts/board.ts and scripts/autopilot.ts read renamed column `git_unattributed_to_live_count`; reason-kind strings unchanged
- [ ] Autopilot simulator zero-on-flip path zeros `git_dirty_count`, `git_unattributed_to_live_count`, AND new `git_orphan_count` (three columns)
- [ ] No regression in board.ts / autopilot.ts test suites
- [ ] At least one new test for renderRowBlocks covering multi-attribution shape

## Done summary

## Evidence
