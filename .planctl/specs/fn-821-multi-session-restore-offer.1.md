## Description

**Size:** M
**Files:** cli/setup-tmux.ts, test/setup-tmux.test.ts, README.md

Parameterize the fn-819 foreground-only restore offer to cover all human work sessions (foreground + background), excluding the autopilot-managed session.

### Approach

Derive `RESTORABLE = WORK_SESSIONS.filter(s => s !== MANAGED_EXEC_SESSION)` (= [background, foreground]; MANAGED_EXEC_SESSION="autopilot"); iterate it in WORK_SESSIONS order for deterministic output. Replace the single `ForegroundCandidateCountFn`/`defaultForegroundCandidateCount` (cli/setup-tmux.ts:503-521) with a per-session COUNT MAP provider: open keeper.db read-only ONCE, `deriveLastGenerationSet(db)`, group `candidates` by `backend_exec_session_id` into a `Record<string,number>` (each candidate carries it; one read, inline group-by); degrade to `{}` on any throw (NOT 0). Make it the injectable 3rd param of `main`. In the offer block (main:587-604, computed BEFORE rebuildDash/ensureWorkSessions:606-607), loop RESTORABLE: probe `has-session` (buildHasSessionArgs:125) per session; include a session only when ABSENT AND `counts[session] > 0`. If the offered set is non-empty AND TTY → render ONE combined prompt naming each offered session and its count (e.g. `Restore last-session agents (foreground: 2, background: 3)? [y/N] `; one offered session → just that one) and call `confirm()` once (it already takes a custom prompt, :479-492); non-TTY → never auto-restore (skip). On a single `y`, after ensureWorkSessions, spawn `restore-agents --apply --session <name> --last-generation` for EACH offered session via the injectable spawn seam using `run()` (NOT runChecked — fire-and-forget, one failure must not abort the other or setup). Parameterize `buildRestoreAgentsArgv(session)` (drop the FOREGROUND_SESSION hardcode at :535). Update the HELP (:41-44), module docstring, and README block to foreground+background.

### Investigation targets

**Required** (read before coding):
- cli/setup-tmux.ts:503-521 (ForegroundCandidateCountFn / defaultForegroundCandidateCount — degrades to 0 today; new map degrades to {}), :505 FOREGROUND_SESSION, :529-538 buildRestoreAgentsArgv (hardcode at :535), :540-543 main signature (provider is 3rd param), :587-604 offer block (single-session, NO loop today), :606-607 rebuildDash/ensureWorkSessions, :612-615 restore spawn (uses run(), not runChecked), :125 buildHasSessionArgs, :479-492 confirm() (custom-prompt capable), :62-66 WORK_SESSIONS, :41-44 HELP
- src/exec-backend.ts:114 MANAGED_EXEC_SESSION="autopilot"
- src/restore-set.ts:131 RestoreCandidate.backend_exec_session_id (non-null), :428-502 deriveLastGenerationSet ({candidates, excludedIdleCount})
- scripts/restore-agents.ts:215-221 — `--session <name>` already generic (filters backend_exec_session_id); no change needed

**Optional**:
- README.md ~1186-1194 (the foreground-only offer prose to revise)

### Risks

- Iterate RESTORABLE (not the count-map keys) so a candidate with a stale/non-WORK_SESSIONS `backend_exec_session_id` can't leak into the prompt; autopilot is excluded at the RESTORABLE level (deriveLastGenerationSet also drops plan_verb='work', a second guard).
- Both has-session probes AND the count map must be computed before rebuildDash/ensureWorkSessions mint a new generation (shifting the kill-anchored window).
- Keep per-session spawns on `run()` so a background-restore ENOENT/non-zero doesn't abort the foreground restore or the completed setup.
- Singular/plural + naming in the prompt: name each offered session with its own count; never claim "2 sessions" when one is offered.

### Test notes

Generalize test/setup-tmux.test.ts: `makeOfferStub` (:579-597) currently special-cases `=foreground` — extend to a per-session exit map so `=foreground`/`=background` presence is driven independently; the injected count provider (:632) changes from `() => number` to a map `() => Record<string,number>`; the ordering assertion (:658-665, has-session before new-session) must cover BOTH probes; `spawnedRestore`/`RESTORE_ARGV` (:564-570) + the buildRestoreAgentsArgv test (:544-556) become per-session (assert `--session background` AND `--session foreground`). Cover the matrix: both absent w/ candidates → both offered + both spawned on `y`; foreground present + background absent → only background; both present → no offer/spawn; absent but count-0 → dropped; non-TTY → no spawn. `bun run test:full` before landing.

## Acceptance

- [ ] RESTORABLE derived from WORK_SESSIONS minus MANAGED_EXEC_SESSION; per-session count map (degrade to {}); offer = absent AND count>0, per session, computed before any session-creating call.
- [ ] ONE combined TTY prompt names each offered session + count; one `y` spawns `restore-agents --apply --session <name> --last-generation` per offered session via run(); non-TTY skips; both-present skips.
- [ ] buildRestoreAgentsArgv(session) parameterized; HELP/docstring/README generalized to foreground+background.
- [ ] test matrix (both-absent / one-absent / both-present / count-0 / non-TTY / per-session argv) passes; `bun run test:full` green.

## Done summary
Generalized the setup-tmux restore offer from foreground-only to all human work sessions (foreground+background, excluding managed autopilot): per-session candidate count map, one combined TTY prompt, per-session run() spawn with continue-on-error, parameterized buildRestoreAgentsArgv. HELP/docstring/README revised; test:full green.
## Evidence
