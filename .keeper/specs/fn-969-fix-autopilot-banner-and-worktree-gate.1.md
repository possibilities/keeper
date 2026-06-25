## Description

**Size:** S
**Files:** src/collections.ts, test/collections.test.ts

### Approach

Add `"worktree_mode"` to `AUTOPILOT_STATE_DESCRIPTOR.columns` (`src/collections.ts:595-611`).
That is the entire serving fix: `runQuery` (`src/server-worker.ts:1335`) projects ONLY
`descriptor.columns`, so the field — present in the write path (`src/reducer.ts:4401` fold,
`src/db.ts:1312` column) but absent from the served column list — never reaches the viewer,
and `projectWorktreeMode` (`cli/autopilot.ts:344`) reads `rows[0].worktree_mode` as
`undefined` → always `false` → permanent `worktree:off`. Keep `worktree_mode` OUT of
`jsonColumns` — it is an INTEGER (0/1), and decoding a scalar as JSON would corrupt it.
Add a served-columns regression test mirroring the pattern at `test/collections.test.ts:376-399`:
INSERT an `autopilot_state` row with `worktree_mode = 1`, call `runQuery` against the
descriptor, and assert the served wire row carries `worktree_mode` (and that the served
key set matches `AUTOPILOT_STATE_DESCRIPTOR.columns`).

### Investigation targets

**Required** (read before coding):
- src/collections.ts:592-620 — `AUTOPILOT_STATE_DESCRIPTOR` (`columns` + `jsonColumns`); `max_concurrent_per_root` is already present at :610, do not duplicate
- src/server-worker.ts:1335 — `runQuery` projects only `descriptor.columns`
- cli/autopilot.ts:344 — `projectWorktreeMode` reads `rows[0].worktree_mode === 1`
- test/collections.test.ts:376-399 — served-columns assertion pattern to mirror

**Optional** (reference as needed):
- src/db.ts:1312 — the `autopilot_state.worktree_mode` column already exists

### Risks

Do NOT add `worktree_mode` to `jsonColumns` (integer, not JSON). No event-sourcing / re-fold
/ schema-version concern — this is a read-side descriptor change only.

### Test notes

Served-columns regression must assert `worktree_mode` is present in the served wire row;
assert per-root too if convenient. Fast tier; this file is not in the slow tier.

## Acceptance

- [ ] `"worktree_mode"` added to `AUTOPILOT_STATE_DESCRIPTOR.columns`, kept out of `jsonColumns`
- [ ] Served-columns regression test added asserting the wire row carries `worktree_mode`, and green
- [ ] `keeper autopilot worktree on` then `keeper autopilot --snapshot` shows `worktree:on`

## Done summary

## Evidence
