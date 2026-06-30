## Description

**Size:** M
**Files:** src/await-conditions.ts, src/readiness-client.ts (opt-in recent-done merge), cli/await.ts (wire the opt-in flag for complete), test/await-conditions.test.ts, test/await.test.ts

Make `await complete` fire at the done-AND-idle moment autopilot actually
unblocks downstream work, instead of the administrative pop-off signal that
can fire too soon.

### Approach

Task complete: in `evaluateTaskAwait` (`src/await-conditions.ts:585-595`)
read `inputs.snapshot.perTask.get(id)?.tag === "completed"` (the readiness
verdict at `src/readiness.ts:804`, gated by `isTaskTerminalCompleted` at
`:722-733` = `worker_phase==="done"` AND no embedded job working AND no
running sub-agent AND no monitor lease) instead of raw `worker_phase==="done"`.
Keep an undefined-guard like the unblocked path (`:607-613`).

Epic complete: the hard half. Today `evaluateEpicAwait` (`:647-655`) is
presence-driven and a done epic DROPS OFF await's open-scoped stream. Add an
OPT-IN extra `epics_recent_done` subscribe in `subscribeReadiness`
(descriptor `src/collections.ts:279-301`, status='done', 1800s window) merged
into the epic set fed to `computeReadiness` — dedup OPEN-wins exactly like
autopilot `loadReconcileSnapshot` (`src/autopilot-worker.ts:4157-4173`). The
merge MUST be conditional on a new `SubscribeOptions` flag that ONLY the
await-complete path (and `keeper status`) sets — board/dash must keep
byte-identical first-paint and `computeReadiness` inputs (do NOT add an
always-on 12th collection to the shared `states`/gate). Then rewrite the
epic-complete branch to read `perCloseRow.get(epic_id)?.tag === "completed"`
(`src/readiness.ts:1077-1084`, `epicHasLiveCloseScopeWork :2383`). New state
machine: present+open→`waiting`; present+done+close-row `completed`→`met`;
present+done+closer-live→`waiting`; absent-from-both-scopes→existing
re-query→`deleted` (retain `await-conditions.ts:701-706` for TRUE deletion).
After 1800s a completion ages out → absent → re-query hit → still `met`
(existing machinery); the agent that arms long after a completion still gets
the right answer.

### Investigation targets

**Required** (read before coding):
- src/await-conditions.ts:585-595 (task complete), :647-655 (epic complete), :685-711 (absent branch), :607-613 (undefined-guard pattern)
- src/readiness.ts:722-733, :804 (task `completed`), :1077-1084, :2383 (close-row `completed` / `epicHasLiveCloseScopeWork`) — NOTE: readiness.ts has a literal NUL byte at line 1648; use `rg`/`grep -a`, plain grep returns nothing
- src/readiness-client.ts:1433-1438 (epics subscribe), :1620-1622 (epicsTyped assembly), :1589-1617 (first-paint gate), :1687-1707 (computeReadiness call)
- src/collections.ts:279-301 (`EPICS_RECENT_DONE_DESCRIPTOR`), :259 (`DONE_EPICS_REAP_WINDOW_SEC=1800`)
- src/autopilot-worker.ts:4157-4173 — the open-wins dedup merge to mirror

### Risks

- HIGH BLAST RADIUS: the recent-done merge touches shared `subscribeReadiness`. The opt-in flag must keep board/dash compute inputs and first-paint timing byte-identical — verify, don't assume.
- Documented behavior change: a task `worker_phase==="done"` whose sub-agent died without SubagentStop stays `running:sub-agent-stale` by design (`readiness.ts:799-803`), so `complete` now reports `waiting` (used to fire `met`) until the operator clears it. Call this out in Done summary; task 5 documents it in the skill.

### Test notes

Pure fixtures in test/await-conditions.test.ts: task done-AND-idle → met; done-but-embedded-job-working → waiting; epic present+open → waiting; epic present+done+idle close-row → met; epic present+done+closer-live → waiting; aged-out → re-query → met; true delete → deleted. Add a readiness-client test that the opt-in flag adds the recent-done set ONLY when set.

## Acceptance

- [ ] Task `complete` reads the `perTask` `completed` verdict; done-but-not-idle → `waiting`.
- [ ] Epic `complete` reads the `perCloseRow` `completed` verdict via an OPT-IN recent-done merge; the new present/done/idle/absent state machine holds; TRUE deletion still → `deleted`.
- [ ] board/dash compute inputs + first-paint are byte-identical when the opt-in flag is off.
- [ ] The done-but-stale-subagent behavior change is documented in Done summary.
- [ ] Pure fixture tests cover every state-machine branch; `bun test` green.

## Done summary
await complete now fires on the readiness done-AND-idle verdict: task reads perTask completed, epic reads the close-row completed verdict via an OPT-IN recent-done merge in subscribeReadiness (board/dash stay byte-identical when the flag is off). BEHAVIOR CHANGE: a task whose worker_phase=done but whose sub-agent died without SubagentStop stays running:sub-agent-stale by design, so complete now reports waiting (was met) until an operator clears it; task 5 documents this in the await skill.
## Evidence
