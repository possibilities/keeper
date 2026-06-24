## Description

**Size:** M
**Files:** src/daemon.ts (producer + actuator), src/exec-backend.ts (reuse agentwrapLaunch), CLAUDE.md/README.md (Autopilot + producer-inventory prose)

Add the daemon-side escalation producer: a heartbeat sweep that finds pending `block_escalations` latch rows, gates by category, and spawns a short-lived one-way CLI helper that notifies `planner@<epic>` over the bus (and wakes it if offline). The producer is the impure side-effecting half; it never writes a projection directly — it mints synthetic events the task-2 fold folds.

### Approach

Clone `sweepExpiredPendingDispatches` (src/daemon.ts:3624-3664) + its heartbeat `setInterval` (3669-3671). Each tick:
1. Query `block_escalations` for `status="pending"` rows (current-state set, naturally bounded — NOT a history scan).
2. **Cancellation guard:** re-check the task is still `blocked` in the live projection; if it cleared, skip (the fold will delete the latch on its own).
3. Read `blocked_reason` from the task's state file (producer-side fs read — allowed; never in a fold) and parse the leading `<CATEGORY>:` prefix. **Gate: escalate unless the category is `TOOLING_FAILURE`** (denylist — `RESUME_EXHAUSTED` and the five worker categories all escalate; only `TOOLING_FAILURE` and an absent/unparseable reason are skipped). For a skipped task, mint `BlockEscalationRequested`+`BlockEscalationAttempted{outcome:"skipped_category"}` so it never re-evaluates.
4. **Coalesce fan-in:** group pending escalatable rows by recipient `planner@<epic>`; at most one send per recipient per sweep cycle.
5. Mint `BlockEscalationRequested` (synthetic event via `stmts.insertEvent.run()`, full param list copied verbatim from src/daemon.ts:2013-2045, then `wakePending=true;pumpWakes()`), THEN spawn the helper async (do NOT block the sweep — `Bun.spawnSync` blocks the loop), THEN mint `BlockEscalationAttempted{outcome}` with the helper result.

The helper invocation: `keeper bus chat send "planner@<epic_id>" -` with the body on STDIN (never interpolate `blocked_reason` into shell args — pass via stdin/array form), plus `keeper bus wake "planner@<epic_id>"` only when the send returns `queued_for_wake`. Body carries: epic_id, task_id, category, blocked_reason, effective repo, and the directive "unblock/refine on the board; the autopilot re-dispatches — no reply needed; if autopilot isn't armed, run `keeper dispatch work::<task_id>`". Build the launcher argv prefix via the existing `buildLauncherArgvPrefix` (src/daemon.ts:3333) and spawn shape; mirror `runWake`'s fail-open, injectable-deps discipline (src/bus-wake.ts:276) so it is testable and never throws into the daemon loop. Arm the producer's timer AFTER the fn-897 actuator gate (src/daemon.ts:2285-2305), like the existing sweep; `clearInterval` on shutdown.

Update CLAUDE.md (Autopilot section + projection-taxonomy/wipe-list paragraphs — forward-facing, no Phase-2c tombstone) and README.md `## Architecture` producer-worker inventory.

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:3624-3671 — `sweepExpiredPendingDispatches` + heartbeat interval (the producer clone source; rides the heartbeat, NOT the data_version wake).
- src/daemon.ts:2013-2045 — synthetic-event mint param list (copy verbatim, ~33 nulled $-params, $event_type discriminator).
- src/daemon.ts:2285-2305 — fn-897 actuator gate (producer arms after).
- src/daemon.ts:1434-1453,3333 — `buildLauncherArgvPrefix` / `Bun.spawnSync` CLI-invocation build.
- src/bus-wake.ts:276 — `runWake` (recipient-side resolution, cooldown/in_flight/single-flight, fail-open, injectable deps) — REUSE for the wake leg; do not rebuild.
- src/exec-backend.ts:1151 — `agentwrapLaunch` signature.

**Optional:**
- cli/bus.ts — `keeper bus chat send <target> -` stdin path (the safe body channel); `keeper bus wake` outcomes.
- src/bus-identity.ts:232-339 — `planner@<epic>` creator-edge resolution (sender-identity independent).

### Risks

- Shell-arg injection via free-text `blocked_reason` — MUST go via stdin/array form, never an interpolated string.
- Spawning synchronously in the sweep tick blocks the daemon loop — spawn async/detached.
- Re-fold re-firing the spawn: the spawn lives ONLY in the producer, never reachable from `applyEvent`.
- Self-creator degrade: if the planner IS the (absent) wielder's session, the send is `not_connected`/never `queued_for_wake` — fail-open, record the outcome, do not crash.
- Fan-in storm if coalescing is skipped — N spawns + N wakes per tick.

### Test notes

Drive the producer with synthetic `block_escalations` rows + an injected helper/launch runner (mirror `runWake`'s injectable deps): assert it gates `TOOLING_FAILURE` out, coalesces per planner, mints Requested-then-Attempted in order, and is fail-open on a spawn error. Use `sandboxEnv` for any real-subprocess leg; `retryUntil`, never sleep. `bun run test:full` mandatory.

## Acceptance

- [ ] Heartbeat sweep escalates a pending blocked task exactly once, minting Requested→Attempted; arms only after the fn-897 gate; clears on shutdown.
- [ ] `TOOLING_FAILURE` (and absent/unparseable reason) skipped with a recorded outcome; all other categories escalate.
- [ ] Cancellation guard skips a task unblocked between detect and spawn; per-planner coalescing caps sends at one per recipient per cycle.
- [ ] Helper sends body via stdin (no shell interpolation) and only wakes on `queued_for_wake`; fail-open on every error.
- [ ] `bun run test:full` green.

## Done summary

## Evidence
