## Overview

`keeper board` grafts "related jobs" under each open epic — creator/refiner link
lines from `epics.job_links`, plus the `[slotted-after-closer]` pill from
`epics.created_by_closer_of`. Both are derived by a TIME-WINDOWED classifier
(`src/plan-classifier.ts`) that only emits an edge for a plan mutation landing
inside a `[/plan:plan_opener, next_opener)` window. A session that never invokes
`/plan:plan` has zero windows, so every plan op it makes is silently dropped.

That gate leaks three populations: **closers** (scaffold their follow-up epic via
`close-finalize`, never invoking `/plan:plan`), **pre-first-opener scaffolds**
(the op happened before the session's first `/plan:plan`), and
**`/plan:defer` / `/plan:next` / direct-CLI edits**. Measured impact on the live
DB: `epics.job_links` empty for ~1013/1020 epics; `created_by_closer_of` set for
0/1020 (the `[slotted-after-closer]` pill has never once fired).

End state: remove the window machinery entirely. Link every epic-MUTATING op in a
session as `creator` (op in {create, scaffold} with an epic-shaped target) or
`refiner` (any other mutating op naming an epic), regardless of time — keeping only
the read-only (`subject_present=false`) gate. Bump `SCHEMA_VERSION` 76→77 and force
a from-scratch re-fold so all existing epics repopulate. Render is already correct
(denormalized, shows terminal/off-page sessions); the bug is purely upstream data.
Human directive: "I'd rather have too many associations than not enough."

## Quick commands

- `bun run test:full` — mandatory; covers the db/reducer/fold paths the fast tier skips.
- `bun test test/plan-classifier.test.ts test/reducer-links.test.ts` — classifier + live-fold link tests.
- After the daemon restarts onto v77 and re-folds: `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT SUM(job_links!='[]') AS with_links, SUM(created_by_closer_of IS NOT NULL) AS closer_linked FROM epics"` — both counts should jump far above the pre-change 7 / 0.
- `keeper board --snapshot` — closer-created epics now show grafted creator lines and `[slotted-after-closer]` pills.

## Acceptance

- [ ] A closer-created follow-up epic (e.g. fn-842/843/844/850/853/854) shows its closer session as a `creator` job-link line and carries `created_by_closer_of` + the `[slotted-after-closer]` pill after re-fold.
- [ ] A pre-first-opener scaffold (the fn-845 case under session 6719a220) links as a `creator`.
- [ ] A from-scratch re-fold reproduces byte-identical `epics.job_links` / `created_by_closer_of` projection rows (re-fold determinism holds).
- [ ] `SCHEMA_VERSION` is 77 and 77 is in `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` (same commit); `test/schema-version.test.ts` passes.
- [ ] `bun run test:full` is green.

## Early proof point

Task that proves the approach: `.1`. The proof is the re-fold count check (`with_links` and `closer_linked` rise from 7 / 0 to broadly populated) plus a new live-fold test asserting a closer with NO `/plan:plan` opener now produces the creator edge AND populates `created_by_closer_of`. If it fails: inspect `deriveJobLinks` output for a known closer-created epic and the per-session sweep in `syncPlanctlLinks`.

## References

- Root-cause evidence: session `6719a220` (one opener at 09:45:40) scaffolded fn-845 at 09:13:57 (before the window) → dropped, while siblings fn-846/847/848/851 (after the opener) linked. 15/15 sampled closer sessions had 0 `plan:plan` openers; `created_by_closer_of`=0/1020.
- `.keeper/specs/fn-598-*` (introduced the `/plan:plan` window model) and `fn-695-*` (commit-trailer UNION channel — KEEP this, it is window-independent) are the historical context for what is being changed.
- Render path confirmed correct: `cli/board.ts:266` `renderJobLinkLines`, `cli/board.ts:473` slotted-after-closer pill, `src/board-render.ts:417`.
- Inter-epic deps: none — all 277 epics are closed; v77 is uncontested.
