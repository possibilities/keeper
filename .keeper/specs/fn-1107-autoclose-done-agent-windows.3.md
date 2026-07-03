## Description

**Size:** M
**Files:** src/autoclose-worker.ts, test/autoclose-worker.test.ts

### Approach

The worker itself, cloned from the renamer worker's shape: isMainThread guard, own
read-only openDb (readonly, prepareStmts false, bootRetry), typed `{type:"shutdown"}`
main->worker teardown, tmux as the ONLY side-effect surface, and one worker->main
message: the pre-kill intent hint. Loop: `watchLoop(db, pulse, isShutdown, pollMs,
AUTOCLOSE_IDLE_MS)` with a NON-ZERO idle wake (~5s; restore-worker precedent) — grace
expiry is time-based and a quiet board never bumps data_version, so a data_version-only
loop would never re-examine a candidate whose grace elapsed.

Export a pure decision core `computeAutocloseReaps(...)` (side-effect free, injected
inputs: jobs rows, readiness snapshot, pane sweep, grace map, config, paused flag, now)
returning kill decisions plus the updated grace map — the unit-test surface. The pulse
orchestrates: re-read config each pulse (live kill-switch both directions; disabled ->
clear state, do nothing); load jobs + readiness via the shared readiness-input module +
computeReadiness; ONE pane sweep per pulse; degraded/empty sweep -> skip the entire
pulse, mint nothing.

Eligibility (ALL must hold): `state === 'stopped'` (terminal rows have NULLed pane ids
— untargetable by design; never touch killed rows), tmux backend, live pane id +
generation present. Autopilot bucket: dispatch_origin 'autopilot' AND plan_verb in
{work, close} (excludes resolve/plan/approve/null) AND readiness verdict completed
(perTask for work keyed by plan_ref; perCloseRow for close keyed by epic id — follow
the await-conditions consumer pattern) AND autopilot unpaused. Panel bucket: birth
session 'panels' AND title matches ^panel::[^:]+::[^:]+$ AND plan_verb/plan_ref NULL.
Both buckets: no permission/input prompt newer than the last stop, live session_name
still the bucket's managed session, grace elapsed.

Grace: a worker-local first-observed-eligible map (jobId -> ts). An entry is pruned the
moment its row is observed ineligible (resumed, killed, verdict regressed) — so any
ineligible observation resets the clock (inherent hysteresis). Daemon restart clears the
map: a restart only DELAYS a close, never accelerates one.

Kill path, per decision, capped at AUTOCLOSE_MAX_KILLS_PER_PULSE (5): re-validate
against the pulse's fresh sweep + a re-read of the row — identity tuple unchanged
(job_id, pid, start_time, pane_id, generation), still stopped, pane present with
pane_dead false and a sane pane_start_time, session still managed, window contains
exactly ONE pane (kill-window destroys every pane; a human's split makes the window
theirs). All rails pass -> post the intent hint to main ({kind, jobId, pid, startTime,
paneId, bucket, ref}) and IMMEDIATELY call killWindow(paneId). A nonzero kill exit is
an expected TOCTOU no-op — treated as done, never re-enqueued, no retry EVER (the retry
loop is what killed the previous incarnation). The row staying 'stopped' until the
Killed event folds is covered by the pane-absent rail next pulse. One stderr audit line
per kill (jobId, bucket, ref, paneId).

The worker never writes keeper.db and never mints events — the hint is the only
worker->main message; main owns the Killed labeling (sibling task).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/renamer-worker.ts — the whole-module template: pulse shape, input-hash dedup gate, injected Pick backend, shutdown protocol, isMainThread guard
- src/wake-worker.ts:96-119 — watchLoop doc + signature; maxIdleMs is the 5th positional arg (default 0)
- src/restore-worker.ts:915 — the precedent non-zero maxIdleMs call
- src/await-conditions.ts:359-410 — the proven consumer reading completed verdicts off perTask/perCloseRow
- src/exec-backend.ts:588-608,730-758 — killWindow + buildTmuxKillWindowArgs semantics (fire-and-check; nonzero exit = expected no-op)
- src/readiness.ts:363-384 — Verdict + ReadinessSnapshot shapes

**Optional** (reference as needed):
- src/reconcile-core.ts:1084 — isBareShellCommand (context only: v1 does NOT reap bare-shell backlog windows)
- test/renamer-worker.test.ts — the pure-core test template (freshMemDb seed, fake pane-ops backend)

### Risks

- The permission-prompt rail depends on comparing prompt timestamps to the stop transition; get the recency comparison right or a worker parked at a dialog gets killed.
- Reading perCloseRow with the wrong key (task id vs epic id) silently never completes close workers — follow the await-conditions pattern exactly.
- An eligible row observed across a daemon restart restarts its grace — intended; do not persist the grace map.

### Test notes

Pure-core matrix over computeAutocloseReaps (freshMemDb + fake pane ops): IN — autopilot-origin
work/close completed+stopped past grace; panel-shape stopped past grace. OUT — manual
plan-form (origin NULL), handoff, pair/agentbus sessions, resolve workers, working rows,
killed rows, verdict running/blocked/ready, prompt-parked, split window (two panes),
pane_dead, session moved, paused (autopilot bucket only — panel still fires), disabled
config, grace not yet elapsed, grace reset on ineligible observation, blast cap enforced,
degraded sweep -> zero decisions, quiet-board idle pulse fires a due reap (maxIdleMs
path), double-kill suppressed next pulse via pane-absent. No real tmux/daemon/Worker —
inject fakes per the test-isolation rules.

## Acceptance

- [ ] The pure decision core passes the full in/out matrix above, including every exclusion class and every safety rail as a distinct case.
- [ ] A due candidate on a quiet board (no DB writes) is reaped by the idle-wake path.
- [ ] Disabling via config yields zero decisions on the next pulse without restart; re-enabling resumes.
- [ ] The module performs no keeper.db writes and posts exactly one intent hint per kill, before the kill.
- [ ] `bun test` green.

## Done summary
Built src/autoclose-worker.ts: the pure computeAutocloseReaps decision core (autopilot + panel buckets, positive-provenance scoping, every negative safety rail fail-closed, worker-local grace clock, blast cap) plus the autoclosePulse orchestration (shared readiness seam, one pane sweep, intent hint before each killWindow, no keeper.db writes). 29-case in/out matrix + seeded-DB pulse smoke test.
## Evidence
