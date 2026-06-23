## Description

**Size:** M
**Files:** src/reaper-worker.ts, src/daemon.ts, src/pair-command.ts (or a new config helper), test/reaper-worker.test.ts

### Approach

Add a SECOND reap arm to `src/reaper-worker.ts` that autocloses any stopped
tracked NON-plan job whose keeper-managed session is in the allow-list. The
discriminator (over `jobs` columns ONLY — the reaper reads no tmux): `plan_verb IS NULL`
AND `(backend_exec_session_id COALESCE backend_exec_birth_session_id)` ∈
`{pair, panels, agentbus}` AND `state='stopped'` AND `now - updated_at > idle-grace`
AND non-null pane+pid, MINUS any session in the `disable-autoclose` list. Keep the
existing autopilot verdict arm (`plan_verb ∈ {work,close}`, `MANAGED_EXEC_SESSION`)
exactly as-is; the allow-list EXCLUDES `autopilot` so the arms never overlap. Reuse
`reaperCycle`'s TOCTOU pre-kill re-check + the shared cooldown map + the load-bearing
periodic tick. The new arm needs ONLY the jobs snapshot + an idle clock — NOT a
readiness verdict, so it must not pull `computeReadiness`. Thread the managed-session
allow-list, the `disable-autoclose` list, and the idle-grace seconds via
`ReaperWorkerData` from the single populate site (`daemon.ts:3956-3960`). agentbus is
covered for free (in the allow-list, already spawns tracked + marked). The new
`ReapCandidate` carries the session name for the audit line (`verb`/`plan_ref` are
NULL for these jobs).

### Investigation targets

**Required** (read before coding):
- src/reaper-worker.ts:143-197 `selectReapCandidates` (extend), :206-221 `selectFromDb`, :247-280 `reaperCycle` (TOCTOU + cooldown), :64-78 `ReaperWorkerData`.
- src/daemon.ts:3956-3960 — the only `ReaperWorkerData` populate site.
- src/types.ts:417/423 — `backend_exec_session_id` (LIVE-only) / `backend_exec_birth_session_id` (the COALESCE target).
- src/exec-backend.ts:115 `MANAGED_EXEC_SESSION` (the autopilot session the allow-list excludes); `createTmuxPaneOps.killWindow` (the kill seam — do not reinvent).
- test/reaper-worker.test.ts — `makeJob` factory, clause-by-clause exclusion tests, `reaperCycle` + `fakeBackend` pattern.

**Optional**:
- src/bus-wake.ts:59-60 — the agentbus `@keeper_managed` marker (tmux-only; the reaper uses the jobs projection, not this) + `AGENTBUS_EXEC_SESSION`.

### Risks

- OVER-REACH (catastrophic): a human's hand-started claude folds to `plan_verb` NULL too. The managed-session allow-list keyed on the frozen birth-session (`KEEPER_TMUX_SESSION`, stamped ONLY by keeper's launch) is the ONLY thing preventing the reaper from killing a human window. Gate on the allow-list, NEVER `plan_verb` NULL alone. Test the human-session exclusion explicitly.
- A fresh pair job reads `backend_exec_session_id` NULL until `TmuxTopologySnapshot` resolves — COALESCE onto birth-session or the new window is briefly missed.
- Stay a pure DB-reading external actuator: no tmux reads, no DB writes; the idle clock is `now - updated_at` (seconds), not a tmux `pane_last_activity` read.

### Test notes

Pure predicate unit tests mirroring the clause-by-clause style: a managed-session stopped+aged job IS reaped; a human-session job (birth-session ∉ allow-list) is NOT; a `disable-autoclose` session is NOT; an autopilot job is untouched by the new arm; the TOCTOU re-check aborts when state flips to `working`. Inject a fake `killWindow` + synthetic job rows — no real tmux (fn-904).

## Acceptance

- [ ] the new arm reaps a stopped tracked managed-session window past the idle grace.
- [ ] a human-session job (birth-session ∉ allow-list) is NEVER reaped (explicit test).
- [ ] a `disable-autoclose` session is not reaped.
- [ ] the autopilot verdict arm is unchanged; no job double-handled across arms.
- [ ] agentbus jobs are covered.
- [ ] the reaper writes nothing to the DB; idle grace + disable-list thread via `workerData`.

## Done summary

## Evidence
