## Description

**Size:** M
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts

### Approach

Recover pass-3 (src/autopilot-worker.ts:3045-3111) sweeps a lane — base OR rib
(`gitListEpicLaneBranches` returns both in one list at :3059, with `lane.epicId`
already stripped of any `--<task>` suffix) — gated ONLY on
`gitIsAncestorOf(lane.branch, LOCAL default)` at :3087, then tears down
(`gitRemoveWorktree` :3092 → `gitPruneWorktrees` :3101 → `gitDeleteBranch -D`
:3103). But a base/rib is BORN at the default tip (provision forkSource,
src/worktree-git.ts:734-736) and is-ancestor is REFLEXIVE
(src/worktree-git.ts:435-445), so an OPEN epic's base — and a clean
freshly-provisioned RIB in the worker-boot window before its first commit — IS
an ancestor of default → pass-3 destroys it MID-FLIGHT (deterministic for the
base every cycle; a race for ribs).

THE FIX — make pass-3 teardown TRI-STATE on epic activity: PRESERVE a lane iff
its epic is PRESENT-in-projection AND NOT done; SWEEP iff the epic is ABSENT
(reaped / EpicDeleted) OR done. Keep the existing is-ancestor check as a
SECONDARY safety (never delete an UNMERGED lane — this also covers the
pass-2-open→done-flip-mid-cycle window). `isEpicDoneById` (:3170-3185) returns
false for BOTH absent AND open epics, so gating on `isEpicDone` ALONE would
still destroy open bases — add a NEW probe `epicPresentAndNotDone(epicId)` =
(epic row exists) AND (status != "done"). It MUST reuse `isEpicDoneById`'s
pk-bypass query frame (collection:"epics", filter:{epic_id}, runQuery(db,0,…),
:3174-3181) which bypasses the OPEN scope AND the DONE_EPICS_REAP recency floor
— a scoped / recency-bounded read would make a live in_progress/blocked epic
read as ABSENT and FALSELY sweep its base (the most dangerous misread). Thread
the new probe as a SEPARATE callback into recover
(`recover(repos, isEpicDone, epicPresentAndNotDone)` → `recoverWorktrees` + the
`WorktreeDriver.recover` interface :1060 + the production bind at :3956 as
`(id) => epicPresentAndNotDone(db, id)`); a separate callback is lower blast
radius than widening `isEpicDone` (3 consumers). When a caller omits it, DEFAULT
to "preserve" (fail-safe — never silently reproduce the sweep bug). pass-3
already has `lane.epicId` per-lane for both base and rib. Rewrite the now-false
pass-3 comment narration (:3045-3056). An orphan rib whose task was refined away
but whose epic is still open is now PRESERVED until the epic closes (finalize
reclaims it at :2646) — an accepted bounded leak (safer than deleting a live
epic's lane).

Do NOT prune the `makeRecoveryGit` (:5524-5525) / `recoverWorktrees`
(:2839-2841) "slow test" comments — they correctly reference the EXISTING plan
slow-tier test at plugins/plan/test/worktree-lifecycle.test.ts.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:3045-3111 — pass-3 loop (gate :3087, teardown :3092-3103, the comment :3045-3056 to rewrite)
- src/autopilot-worker.ts:3170-3185 — isEpicDoneById (the pk-bypass query frame to CLONE; returns false for absent AND open)
- src/autopilot-worker.ts:2860 (recoverWorktrees sig), :1060 (WorktreeDriver.recover interface), :3956-3957 (production bind site)
- src/worktree-git.ts:648-680 (listEpicLaneBranches — lane.epicId base/rib), :435-445 (isAncestorOf reflexive), :734-736 (fork-at-default-tip birth)
- test/autopilot-worker.test.ts:5751-5875 (pass-3 cluster), :5501-5590 (makeRecoveryGit harness), :5796 + :5814 (the misleading "reaped" test to fix), :6099-6121 (seedEpicRow DB-probe test pattern)

### Risks

- The pk-bypass frame is load-bearing: a scoped read false-sweeps a live in_progress/blocked base. Clone the id-based bypass frame exactly.
- Keep the is-ancestor secondary gate (never force-delete an unmerged lane; never `git branch --contains`).
- Default the omitted-probe direction to PRESERVE (fail-safe), not sweep.

### Test notes

Pure fake-runner (makeRecoveryGit, `ancestors: new Set([base])` so the base IS a
reflexive ancestor): OPEN epic (present, not done) base → PRESERVED;
reaped/absent merged base → SWEPT; done epic merged base → SWEPT; OPEN clean
fresh RIB at default tip → PRESERVED; unmerged (not-ancestor) lane → always
PRESERVED. New probe unit test (seedEpicRow open/done/absent →
epicPresentAndNotDone true/false/false). Fix the misleading :5796 test so
"reaped" seeds status="done" or an absent row (not `async () => false` standing
in for "absent"). Optionally a PLAN slow-tier (KEEPER_PLAN_RUN_SLOW) real-git
case in worktree-lifecycle.test.ts / worktree-fork.test.ts: a recover cycle while
an epic is OPEN leaves its base + ribs intact.

## Acceptance

- [ ] pass-3 PRESERVES an open epic's base/rib that is a reflexive ancestor of default (born at the tip, no commits)
- [ ] pass-3 still SWEEPS a merged base/rib whose epic is absent (reaped) OR done
- [ ] the new epicPresentAndNotDone probe reuses the pk-bypass frame (a live in_progress/blocked epic reads present-not-done, never absent)
- [ ] the probe is a separate callback; an omitted probe defaults to preserve
- [ ] the is-ancestor secondary gate is kept (an unmerged lane is never force-deleted)
- [ ] the misleading :5796 test is corrected to mean absent-or-done; open-base + open-rib preserve tests are added

## Done summary

## Evidence
