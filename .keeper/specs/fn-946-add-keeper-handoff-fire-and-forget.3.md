## Description

**Size:** M
**Files:** src/handoff-worker.ts, src/daemon.ts, src/derivers.ts, src/reducer.ts

### Approach

Build the dispatch half: a new `src/handoff-worker.ts` (isMainThread guard,
openDb readonly + prepareStmts:false, parentPort null-guard — mirror
`src/builds-worker.ts`), spawned in `src/daemon.ts` after boot-drain (mirror the
autopilot spawn glue). The worker is level-triggered on `data_version`; each
cycle it selects actionable `handoffs` rows and dispatches, borrowing autopilot's
mint-before-launch protocol (`confirmRunning`): capture the events watermark,
post a worker→main message that mints a durable `HandoffDispatching` event
(stamping `claimed_at` from the event ts) and AWAIT the ack BEFORE
`agentwrapLaunch` into `target_session` with `--name handoff::<handoff_id>` and
the prompt = `handoff_prompt_prefix` + a short pointer ("First run
`keeper handoff show <id>` to load your brief, then carry it out."). Bind: add a
`handoff::` sibling parser in `src/derivers.ts` (next to `SPAWN_VERB_REF_RE` — a
NEW $-anchored, kebab-scoped regex; do NOT widen the plan-verb one), and a
`SessionStart` fold arm in `src/reducer.ts` that, on a `handoff::<id>` spawn
name, sets `handoffs.callee_job_id` + status="bound" and writes the handoff-to
`HandoffLinkEntry` on the callee job. BOOT-RECOVERY (the durable-projection
idempotency — the headline risk, because `handoffs` SURVIVES boot unlike the
boot-truncated `pending_dispatches`): each cycle, before dispatching, run the
level-triggered bind check — "does a `handoff::<id>` SessionStart exist?" If
bound, skip. A `requested` row → dispatch. A `dispatching` row → re-dispatch ONLY
if `claimed_at` is older than a TTL lease AND no bind exists (a fresh dispatching
row is left alone; lease expiry NEVER un-registers an already-bound worker).
Never-bound breaker: K=3 consecutive `HandoffDispatchExpired` without a bind →
sticky `failed` status (mirror foldDispatchExpired / NEVER_BOUND_EXPIRE_THRESHOLD).
Every permanent launch failure mints a `HandoffLaunchFailed` event (terminal
`failed` status) + a dead-letter. ALL wall-clock / TTL comparisons live in the
WORKER (producer), never the fold; `claimed_at` is event-ts-derived so re-fold
stays byte-identical. Validate `target_session`/`target_repo` before launch
(gated-roots spirit). The bound job lands in the human's live session as a NEW
WINDOW (not pane-sharing) — confirm it doesn't trip the reaper's
managed-session/orphan arms.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:1211-1308 — confirmRunning (mint-before-launch, await ack, poll-to-bind, ceiling<TTL<cooldown ordering)
- src/builds-worker.ts — worker boilerplate (isMainThread:14, openDb readonly:50, parentPort guard:476, workerData:481)
- src/daemon.ts:3303-3375 — autopilot spawn glue + onmessage mint-per-{kind}; :3050-3075 — builds-worker poll-producer spawn
- src/derivers.ts:34 — SPAWN_VERB_REF_RE + :96-108 planVerbRefFromSpawnName (add a handoff:: sibling; $-anchored, kebab-scoped)
- src/reducer.ts:6577-6694 — the SessionStart spawn-name → plan_verb fold (where the handoff:: arm goes); :3840 — foldDispatchExpired never-bound breaker (K=3); :5450-5514 — link enrich (to-side)
- src/exec-backend.ts:1151 — agentwrapLaunch; :983-984 — KEEPER_TMUX_SESSION injection
- src/reaper-worker.ts — managed-session + orphan arms (confirm a human-session window is not reaped)

**Optional** (reference as needed):
- src/db.ts pending_dispatches.dispatched_at — the wall-clock-in-producer-not-fold precedent

### Risks

- Crash between the HandoffDispatching ack and the launch leaves a phantom `dispatching` row that SURVIVES boot (handoffs is durable) — the claimed_at lease + bind-check is the only thing preventing BOTH a stuck row AND a double-dispatch.
- A sync Bun.spawnSync must not block the worker loop indefinitely — bound it.
- `handoff::` must NOT match SPAWN_VERB_REF_RE (else it pollutes plan_verb / readiness).
- Re-fold determinism: the SessionStart bind fold reads ONLY the event payload; all TTL/liveness logic is producer-side.

### Test notes

- reducer-projections: a handoff:: SessionStart binds callee_job_id + status=bound + to-link; a plan:: SessionStart is unaffected; byte-identical re-fold.
- handoff-worker unit test of the boot-recovery decision table (requested / dispatching-stale / dispatching-fresh / bound) with synthetic rows — NO real spawn (inject the launch + clock).
- never-bound breaker trips at K=3.

## Acceptance

- [ ] src/handoff-worker.ts spawned after boot-drain; read-only db; never writes keeper.db directly
- [ ] mints HandoffDispatching (durable-acked) BEFORE agentwrapLaunch into target_session with --name handoff::<id>
- [ ] handoff:: sibling parser added; SPAWN_VERB_REF_RE unchanged; SessionStart binds callee + status=bound + to-link
- [ ] boot-recovery decision table correct (no double-dispatch of a bound/fresh-dispatching row; re-dispatch of a stale one); never-bound breaker at K=3 → failed; HandoffLaunchFailed + dead-letter on permanent failure
- [ ] all TTL/liveness reads are producer-side; folds pure + byte-identical re-fold
- [ ] the handoff-ee window in the human session is not reaped; test:full green

## Done summary
Built the handoff dispatch worker (src/handoff-worker.ts): level-triggered, read-only db, durable boot-recovery decision table + mint-before-launch confirm path; the handoff:: deriver + SessionStart bind fold + HandoffDispatching/HandoffLaunchFailed lifecycle folds (K=3 never-bound breaker) in the reducer; daemon spawn + mint glue (18 workers). test:full green.
## Evidence
