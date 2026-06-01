## Description

**Size:** M
**Files:** src/autopilot-worker.ts (new), test/autopilot-worker.test.ts (new)

### Approach

Implement the reconcile decision and `confirmRunning` as dependency-injected,
unit-testable logic (mirror how `cli/autopilot.ts` exports pure functions tested
without spawning). The pure `reconcile(snapshot, state, deps)`:

1. `computeReadiness(epics, jobs, subagentInvocations, gitStatus)` — feed the LIVE
   `git_status` map so fn-638 predicate 6.5 still gates (do NOT pass empty).
2. For each row whose verdict wants verb V: skip if an OCCUPYING job exists
   (a `{spawned, working, stopped}` non-terminal `jobs` row with
   `plan_verb == V AND plan_ref == id`), skip if an open `dispatch_failures` row
   exists for `(V, id)`, skip if a dispatch is in-flight. Otherwise dispatch.
3. Symmetric reap: when the autoclose config flag is on, for a live dispatch whose
   role is no longer needed per autopilot state (job terminal, or readiness no
   longer wants the verb / row superseded), call `deps.closeByName(name)`.

`confirmRunning(verb, id, deps)`: capture `watermark = MAX(events.id)` BEFORE
`deps.launch(argv, name)`; on `{ok:false}` emit failure immediately; else poll
`deps.findJob(plan_verb=V, plan_ref=id, last_event_id > watermark)` every ~1-2s
until present (GOOD) or a ~15-20s ceiling (BAD → `deps.emitDispatchFailed`). Use
`Math.min(interval, remaining)` on the last tick. Serialize launches
one-at-a-time (preserve the fn-644 stagger). Correlation is `plan_verb`+`plan_ref`
— `jobs` has NO `spawn_name` column; the reducer derives the pair via
`planVerbRefFromSpawnName`. The watermark excludes a stale terminal/resumed row
for the same `verb::id`. All side effects are injected deps (`launch`,
`closeByName`, `findJob`, `emitDispatchFailed`, `now`, `config`) so the core is
pure. The module's `main()` (isMainThread-guarded) owns its read-only conn, a
`data_version` wake loop, and a shutdown handler that aborts any in-flight confirm.

### Investigation targets

**Required** (read before coding):
- src/readiness.ts:305 — computeReadiness signature; Verdict union :260
- src/reducer.ts:1927 — LIVE_STATES; state-transition doc :14-53 (the job-state partition)
- src/derivers.ts:169 — planVerbRefFromSpawnName (the correlation derivation; confirms jobs has no spawn_name)
- cli/autopilot.ts:855 — isLiveSessionInRoot (the root-scoped dedup being replaced by job-presence); :502 buildWorkerCommand; :705 tier sourcing
- src/wake-worker.ts:69-150 — watchLoop / data_version wake-loop shape (export watchLoop for tests)
- src/exit-watcher.ts — dual-loop worker + shutdown-handler-aborts-in-flight pattern

**Optional** (reference as needed):
- CLAUDE.md `## Worker contract` — isMainThread guard, own readonly conn, no self-heal
- The fn-644 startup-stagger rationale in cli/autopilot.ts settling logic

### Risks

- The confirm watermark and the dedup partition MUST agree on the same job-state partition, or a stale terminal row either blocks re-dispatch or falsely confirms.
- `approve::id` and `work::id` share `plan_ref` — confirm/dedup must gate on `plan_verb` too.
- Forgetting the live `git_status` feed silently disables the fn-638 git-orphans gate server-side.
- Clock reads are confined to the worker's confirm path (poll-time `now`), never anything that feeds a fold.

### Test notes

- Drive reconcile + confirmRunning with injected fakes (fake launch/findJob/clock/config): GOOD path (job appears before ceiling), BAD path (ceiling → emitDispatchFailed), dedup suppression (occupying job / open failure / in-flight), no-op fast path (nothing ready), reap path (flag on + role discharged → closeByName). No real worker spawn.

## Acceptance

- [ ] Pure `reconcile` + `confirmRunning` with injected deps; covered by unit tests for GOOD / BAD / dedup / no-op / reap
- [ ] Dedup = occupying-job presence by `(plan_verb, plan_ref)`; no surface probe anywhere
- [ ] confirm watermark excludes stale terminal/resumed rows; ceiling ~15-20s → DispatchFailed, no auto-retry
- [ ] git_status fed to computeReadiness (fn-638 gate intact); launches serialized one-at-a-time (fn-644)
- [ ] isMainThread-guarded main() with readonly conn, data_version wake loop, shutdown aborts in-flight confirm

## Done summary
Added src/autopilot-worker.ts: pure reconcile(snapshot,state,liveDispatches,config,now) + confirmRunning(verb,id,cwd,argv,signal,deps) with injected deps (launch/findJob/maxEventId/now/sleep/emitDispatchFailed). Dedup by occupying-job presence on (plan_verb,plan_ref) in {working,stopped}; sticky failure via dispatch_failures keys; watermark-before-launch excludes stale terminal rows; ~18s ceiling, no auto-retry. git_status fed to computeReadiness (fn-638 6.5). runReconcileCycle serializes launches one-at-a-time (fn-644). isMainThread-guarded main() with readonly conn, watchLoop, shutdown AbortController. 29 worker tests + 431 epic suite pass.
## Evidence
