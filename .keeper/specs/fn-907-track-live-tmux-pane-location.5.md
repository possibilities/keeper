## Description

**Size:** M
**Files:** src/restore-set.ts, src/dash/view-model.ts, cli/jobs.ts, cli/setup-tmux.ts, test/refold-equivalence.test.ts, README.md, CLAUDE.md

Make consumers fall back to the birth session so demotion never regresses behavior, accommodate
the re-fold charter for the new live-only columns, and update the docs.

### Approach

Crash-restore + grouping fallback: where a consumer reads `backend_exec_session_id` for
candidacy/grouping, use `COALESCE(backend_exec_session_id, backend_exec_birth_session_id)` so a
session not yet resolved by a topology snapshot still restores/groups as before:
`src/restore-set.ts` (the `IS NOT NULL` candidacy gate ~line 523 + sort), `src/dash/view-model.ts`
(grouping ~line 161), `cli/jobs.ts` (~line 349), `cli/setup-tmux.ts` (~line 526). Verify the
restorable set + dash grouping do not shrink vs today.

Re-fold charter: ensure `test/refold-equivalence.test.ts` excludes/blanks the two new live-only
columns (`backend_exec_session_id`, `window_index`) before the byte-identical `jobs` comparison —
mirror however it already handles the git-counter live-only columns (floor-reset accommodation or
explicit column blanking).

Docs (forward-facing, present tense, no change-history narration): update README.md (hook-scraping
intro ~67-77; backend-exec coordinates ~2006-2036; window_index/close_kind ~2186-2195; restore-worker
desc ~2848-2869; projection-class/live-only taxonomy ~1858-1884; add an "As of schema v83" block)
and CLAUDE.md/AGENTS.md (projection-class taxonomy ~65-99 — add the tmux live surface +
`tmux_projection_state`; "Scraping is scoped" ~164-167 — `KEEPER_TMUX_SESSION` → birth column).
Edit CLAUDE.md in place (AGENTS.md is a symlink — never rm+recreate).

### Investigation targets

**Required** (read before coding):
- src/restore-set.ts:~523 — `backend_exec_session_id IS NOT NULL` candidacy gate + window_index sort
- src/dash/view-model.ts:~161 — session grouping (DETACHED_KEY bucket)
- cli/jobs.ts:~349, cli/setup-tmux.ts:~526 — session group/count
- test/refold-equivalence.test.ts:~747-807 — `snapshotProjections` `SELECT * FROM jobs` + the live-only accommodation
- README.md + CLAUDE.md passages enumerated above

**Optional** (reference as needed):
- src/restore-set.ts:~428 — `BackendExecStart` generation window (context for restore keying)

### Risks

- Missing a consumer's session read leaves a transient DETACHED mis-group or a shrunk restore set
  on every boot until the first topology snapshot resolves.
- The refold charter must exclude BOTH new live-only columns or the determinism test fails.
- Doc edits must be forward-facing only (no "formerly/renamed-from" narration).

### Test notes

Assert `test/refold-equivalence.test.ts` passes with the two columns excluded; a unit test that a
job with NULL live session but a non-NULL birth session is still a restore candidate / groups under
the birth session. Run `bun run test:full`.

## Acceptance

- [ ] restore-set, dash view-model, cli/jobs, cli/setup-tmux fall back to
      `COALESCE(backend_exec_session_id, backend_exec_birth_session_id)`; restorable set + dash
      grouping do not regress.
- [ ] `test/refold-equivalence.test.ts` excludes both new live-only columns and is green.
- [ ] README.md + CLAUDE.md/AGENTS.md updated per the enumerated passages, forward-facing only.
- [ ] `bun run test:full` green.

## Done summary

## Evidence
