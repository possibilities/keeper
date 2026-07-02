## Description

**Size:** S
**Files:** src/autopilot-worker.ts, src/await-conditions.ts, test/autopilot-worker.test.ts, plugins/keeper/skills/await/SKILL.md

### Approach

Gate ONLY the definitively-absent arm of `laneMergedInRepo` (src/autopilot-worker.ts:2631-2632, `if (!lanes.branches.has(laneBranch)) return true`) on the epic having ever started: export the existing private `epicStarted` predicate from src/await-conditions.ts:457-467 (single source of truth — jobs present OR any task started per taskStarted at :442-450; verify the import introduces no runtime cycle, its readiness/derivers imports are types-only; optionally add `epic.status === "done"` as a belt-and-suspenders disjunct) and consult it at the two vulnerable call sites inside `computeMergedLaneEntries` — the `ok` path (:2658) and the clustered worktree-group path (:2674) — either by threading an epicStarted boolean into `laneMergedInRepo` or checking before trusting absence. A never-started epic with an absent lane reads NOT merged (landed waits). The clustered serial-group arm (:2675-2677) already keys on worker_phase done — leave it. Keep every conservative arm exactly as-is: enumeration-failed (:2628-2629) and unresolvable-default (:2635-2636) still return false; the present-and-ancestor arm (:2634-2639) unchanged; the aggregate no-early-emit-until-ALL-groups semantics (:2670-2688) unchanged. The worktree-OFF degrade (`computeLandedEpicIds`, src/readiness-client.ts:483-485) never trusts lanes and is out of scope. `computeMergedLaneEntries` stays pure (epic data + injected git run only). Update the keeper:await skill doc's `landed` row (plugins/keeper/skills/await/SKILL.md) to state the started gate in one clause, forward-facing.

Heads-up: use `rg -a` on src/autopilot-worker.ts (a NUL byte ~offset 175300 breaks plain grep below ~line 5000).

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:2573-2700 — computeMergedLaneEntries + laneMergedInRepo, all arms
- src/await-conditions.ts:442-467 — taskStarted/epicStarted, the predicates to export
- test/autopilot-worker.test.ts:9693-9950 — the computeMergedLaneEntries suite; :9729 is the absent-lane test that must gain a started signal
- src/autopilot-worker.ts:2550-2553,2619-2622 — the conservative-degrade direction comments (under-report, never claim merged)

## Acceptance

- [ ] Never-started epic + absent lane → no merged entry (new red-first regression test); started epic + absent lane → merged entry (the :9729 test updated with a started signal)
- [ ] Probe-failure arms and clustered aggregate semantics byte-unchanged; worktree-off path untouched
- [ ] epicStarted exported and consumed (no duplicate predicate); await SKILL.md landed row updated
- [ ] Full fast suite green

## Done summary

## Evidence
