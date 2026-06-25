## Description

**Size:** M
**Files:** src/reaper-worker.ts, src/exec-backend.ts, src/db.ts, src/daemon.ts, README.md, plugins/keeper/skills/pair/SKILL.md, plugins/plan/skills/panel/SKILL.md, test/reaper-worker.test.ts, test/config.test.ts

### Approach

Three coordinated changes that land the single unified autoclose rule. Depends on
task .1's glob matcher.

1. DELETE the orphan raw-process arm entirely from `src/reaper-worker.ts`:
constants (`ORPHAN_*`), types (`ProcCensusEntry`/`OrphanCandidate`/`OrphanTermState`),
`matchesOrphanSignature`, `selectOrphanedProcessCandidates`, `enumerateProcessCensus`,
`parsePsCensusLine`, the raw-pid `process.kill` actuator, `orphanReapCycle`, the
`main()` orphan wiring + its `driveCycle` call, the `ReaperWorkerData.disableOrphanReap`
field, and the now-unused `readOsStartTime`/`isPidAlive` imports. Delete the
`disable_orphan_reap` config key (`src/db.ts` field + parse + ALL THREE return
sites) and its `src/daemon.ts` workerData wiring. Leave ONE short forward-facing
comment where the arm was: runaway processes are fixed at their source, not reaped
by the daemon.

2. COLLAPSE `selectReapCandidates` + `selectManagedSessionReapCandidates` into ONE
selector. A job's window reaps iff: `backend_exec_birth_session_id IS NOT NULL`
(keeper created the session — the IDENTITY test; NOT `COALESCE(live,birth)`, since a
human session has a live name but NULL birth) AND `backend_exec_type = 'tmux'` AND
`state IN ('stopped','ended')` AND `now - updated_at > grace` AND the
`disable_autoclose` matcher does NOT match (test BOTH live and birth session) AND
`backend_exec_pane_id` non-null AND not in the kill cooldown. Drop `computeReadiness`
/ the reconcile-snapshot verdict from `selectFromDb` — a light `jobs` read replaces
it. Keep `reaperCycle`'s pre-kill re-check (it now re-confirms state/idle, not a
verdict — a resumed worker flips `stopped → working` and aborts the kill). Delete
`MANAGED_AUTOCLOSE_SESSIONS` and the `MANAGED_EXEC_SESSION` special-casing in
`src/exec-backend.ts` (KEEP the session-name constants the launchers still use).
Simplify `ReapCandidate` / `describeCandidate` to the single arm.

3. Make the grace CONFIGURABLE: new config key `autoclose_grace_seconds` (default 3)
in `src/db.ts` (best-effort parse, all three return sites), threaded via
`src/daemon.ts` → reaper `workerData`, replacing `REAP_STOPPED_AGE_SEC` +
`REAP_MANAGED_SESSION_IDLE_SEC`. Keep `REAP_KILL_COOLDOWN_SEC` and the LOAD-BEARING
periodic tick. Compile the `disable_autoclose` matcher once at worker boot (frozen
for the worker's lifetime, like today's Set).

Then rewrite the README autoclose sections and the two skill docs to the one rule.

### Investigation targets

**Required** (read before coding):
- src/reaper-worker.ts:184-238 (`selectReapCandidates`), 268-319 (`selectManagedSessionReapCandidates`), 768-796 (`selectFromDb` — drop verdict), 822-858 (`reaperCycle` — keep re-check), 321-756 (orphan block — DELETE), 91-95 (`disableOrphanReap` field), 901-936 (`main` wiring), 974-990 (orphan `driveCycle` call), 1007-1014 (tick — keep), 110-135 (grace constants)
- src/exec-backend.ts:150-154 (`MANAGED_AUTOCLOSE_SESSIONS` — delete), 123 (`MANAGED_EXEC_SESSION` special-casing)
- src/db.ts:343-349 (`disable_autoclose` parse), 353-360 (`disable_orphan_reap` — DELETE), 186-188, and the THREE return sites 260-267 / 378-385 / 387-401
- src/daemon.ts:5188-5196 (`disableOrphanReap` wiring + reaper workerData)
- src/autopilot-worker.ts:1107-1144 (`isOccupyingJob`/`isStoppedJobLive` — the slot-occupancy coupling)

**Optional** (reference as needed):
- src/reducer.ts:7761-7765 (Stop→`stopped`), 7774-7787 (SessionEnd→`ended`), 7845 (Killed→`killed`)
- src/restore-set.ts:262-274 (`isCrashLike` — reaped window is `window_gone_server_alive`, never a restore candidate)
- README.md:438-443, 456-467, 495-496, 3119-3136, 3341-3394; plugins/keeper/skills/pair/SKILL.md:62-63,124; plugins/plan/skills/panel/SKILL.md:139-141
- test/reaper-worker.test.ts (factories `makeJob`/`makeManagedJob`, orphan tests 542-928 to DELETE); test/config.test.ts (`disable_orphan_reap` tests to delete)

### Risks

- IDENTITY must be birth-session non-null (NOT `COALESCE(live,birth)`) — a human session has a live name but NULL birth; keying on live would mis-reap human windows. The opt-out test, separately, matches BOTH live and birth.
- Dropping the verdict gate: a cleanly-stopped-but-incomplete plan worker is now reaped → slot frees → autopilot re-dispatches (bounded by `REDISPATCH_COOLDOWN_S=200`, no sticky stop-incomplete breaker). ACCEPTED behavior change — assert the cooldown bounds the re-dispatch rate; a sticky breaker is a noted follow-up, out of scope.
- All THREE `resolveConfig` return sites must drop `disable_orphan_reap` or the config shape silently drifts.
- Removing the orphan arm drops a host-stability backstop — the fix-at-source assumption MUST be documented in the comment left at the deletion site.

### Test notes

- Rewrite `test/reaper-worker.test.ts` to the single predicate with clause-by-clause exclusion (NULL birth, wrong backend, `state` working/killed, within grace, opt-out match, NULL pane, cooldown). Assert BOTH `stopped` and `ended` reap; `killed` never reaps. DELETE all orphan tests.
- Restore-set non-regression: a reaped autopilot window classifies `window_gone_server_alive` → not a restore candidate.
- Grace config: `autoclose_grace_seconds` default 3, override respected, garbage → default.
- `bun run test:full` (touches worker/db/daemon paths).

## Acceptance

- [ ] Orphan raw-process arm and `disable_orphan_reap` config fully removed (code, config, daemon wiring, tests); a forward-facing comment notes runaways are fixed at source
- [ ] ONE reap selector: reaps a job window iff birth-session non-null AND `backend_exec_type='tmux'` AND `state IN ('stopped','ended')` AND idle > grace AND not opt-out-matched AND pane-id present AND not in cooldown; no readiness/verdict computed in the reap path
- [ ] `MANAGED_AUTOCLOSE_SESSIONS` deleted; the `autopilot` session reaps via the unified rule and is gated by `disable_autoclose` like any other; a human session (NULL birth) is never reaped
- [ ] `autoclose_grace_seconds` config key (default 3) governs the single grace, threaded to the reaper; `killed` (crashed) windows are never reaped
- [ ] README autoclose sections + pair/panel skill docs rewritten to the one rule (no fn-ids, no stale 60s/~20s timings, no `disable_orphan_reap`, no "two arms"); `bun run test:full` green

## Done summary

## Evidence
