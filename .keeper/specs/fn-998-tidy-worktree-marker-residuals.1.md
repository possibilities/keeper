## Description

**Size:** S
**Files:** src/daemon.ts, src/git-boot-seed.ts, src/tmux-boot-seed.ts (synthetic inserts), src/reducer.ts (comment), cli/jobs.ts + src/collections.ts (glyph), README.md (doc note)

### Approach

Four independent, NON-behavioral cleanups from the fn-997 panel. The marker
feature is already shipped + v94 is live; none of these change fold/capture logic.

1. **R3 — synthetic-insert `worktree` parity.** The synthetic event-insert sites
(src/daemon.ts, src/git-boot-seed.ts, src/tmux-boot-seed.ts) bind `$config_dir:null`
/ `$mutation_path:null` but NOT `$worktree`. bun 1.3.14 binds a missing named param
to NULL so this is safe TODAY, but it breaks the codebase's explicit-every-column
convention and is fragile if bun ever tightens. Add `$worktree: null` to each
synthetic insert using the `insertEvent` shape, matching the config_dir/mutation_path
bindings. No behavior change (still folds NULL).

2. **R5 — pill glyph consistency.** cli/jobs.ts (~:247-249) renders the worktree pill
with `⑂` (U+2442); src/collections.ts (~:141) comment shows `[⊟ …]`. Pick ONE glyph
and make the renderer + every comment/doc agree (the shipped renderer uses `⑂`).

3. **R2 — fold comment accuracy.** src/reducer.ts (~:7387, the jobs.worktree set-once
COALESCE) comments "a resume sends NULL, so COALESCE preserves the first-launch
branch." A resume actually RE-INJECTS the same branch env (per the exec-backend
resume test), so excluded.worktree is the same branch, not NULL — COALESCE is safe
under both readings, but the stated mechanism is wrong. Correct the wording to
reality (resume re-injects the same branch; COALESCE idempotent/safe either way),
KEEPING the "MUST stay on the SessionStart arm (never the every-event backend_exec
arm)" guidance intact.

4. **In-flight-at-deploy doc note.** Jobs already running when v94 landed keep
`jobs.worktree=NULL` for life (their SessionStart folded before the column existed;
there is no backfill). Document this (README worktree/jobs section, alongside the
pill) so it reads as expected, not a bug.

### Investigation targets

**Required** (read before coding):
- src/db.ts insertEvent named-param shape (the `$worktree` param) + the synthetic insert call sites in src/daemon.ts / src/git-boot-seed.ts / src/tmux-boot-seed.ts (find via the insertEvent / `INSERT INTO events` shape; mirror how `$config_dir:null` is bound)
- src/reducer.ts ~:7387 (the jobs.worktree COALESCE comment) + ~:7449 (fold binding) for context
- cli/jobs.ts ~:247-249 (pill renderer) + src/collections.ts ~:141 (comment glyph)
- test/exec-backend.test.ts (the resume test confirming resume re-injects the branch — grounds the R2 fix)

### Risks

- All four are NON-behavioral (NULL stays NULL; glyph/comment/doc only). The gate must stay green with the fold byte-identical; do NOT touch the set-once COALESCE logic or its SessionStart-arm placement — only comment wording.
- Adding `$worktree:null` must not change any synthetic event's folded result (already NULL).
- This edits daemon-core insert sites; it is a no-op functionally, so no migration / schema change and no SCHEMA_VERSION bump.

### Test notes

The existing suite already covers marker behavior; these are non-behavioral, so the
gate (`bun run test`) staying green is the proof. Optionally assert a synthetic event
folds worktree=NULL (already implied by the existing fold tests).

## Acceptance

- [ ] synthetic inserts bind worktree explicitly (NULL); explicit-every-column convention restored
- [ ] one consistent pill glyph across renderer + comments/docs
- [ ] the reducer resume comment accurately states resume re-injects the same branch
- [ ] in-flight-at-deploy no-backfill behavior documented
- [ ] `bun run test` green; no marker behavior change; no SCHEMA_VERSION bump

## Done summary

## Evidence
