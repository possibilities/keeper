## Description

**Size:** M
**Files:** src/autoclose-worker.ts, test/autoclose-worker.test.ts

### Approach

Add the third autoclose bucket so finished escalation windows are reaped. Membership is positive provenance only: `dispatch_origin === 'escalation'` AND `plan_verb ∈ {unblock, deconflict, resolve}` AND `escalation_instance` non-null — never the window title. Rails are identical to the autopilot bucket: state `'stopped'`, tmux backend, pane-id + generation resolved and live, `last_input_request_at`/`last_permission_prompt_at` both null (never reap a prompt-parked session), single-pane window, blast-cap, suspended under autopilotPaused, `autoclose_enabled` + the existing grace knob. Done-signal is instance-precise per verb, read fail-closed on the worker's own read-only connection: unblock — no `block_escalations` row with `blocked_since == escalation_instance`; deconflict and resolve — no `dispatch_failures` `close::<epic>` row with `instance_event_id == escalation_instance`. Any read error skips the pulse and reaps nothing. The done-signal and the kill ride the same pulse's fresh read (the TOCTOU guard — never kill on a prior pulse's verdict), and the `stopped` rail is what protects the skill's final bus-resume message (it sends inside the turn), so the done-signal must never key on the board flip alone.

A consequence to preserve, not fix: a declined session's window persists until its incident instance clears (its done-signal is false while the block/conflict stands) — intended evidence-retention; its slot is already free via turn-activity.

This deliberately flips the existing "OUT: resolve worker → never reaped" rail case — a resolve session with the escalation stamp and a resolved instance is now IN.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/autoclose-worker.ts:220-263 — classifyEligible, the two existing buckets and the fall-through
- src/autoclose-worker.ts:308 — computeAutocloseReaps pure core; :238-244 the readiness done-signal gate the autopilot bucket uses (the escalation bucket's done-signal is its sibling seam)
- src/autoclose-worker.ts:210-218 — the prompt-parked exclusion rails to reuse verbatim

**Optional** (reference as needed):
- test/autoclose-worker.test.ts:123-330 — the IN:/OUT: rail matrix + fixture builders to extend with an escalationSession(over) builder
- test/autoclose-worker.test.ts:211 — the resolve OUT case that flips
- test/autoclose-worker.test.ts:552 — the seeded-DB autoclosePulse smoke test (needs the new columns from task 2's migration)

### Risks

- The worker owns a read-only connection (Worker contract) — both done-signal tables must be readable from its snapshot, and a degraded read must skip, never reap.
- Grace tuning: too-aggressive reaping of a session mid-transition is the Kestra duplicate-execution failure shape; the stopped rail + same-pulse re-read + existing grace are the defense — do not add a faster path.

### Test notes

Extend the rail matrix: IN for each verb with resolved instance; OUT for open instance (declined-session persistence), NULL instance, NULL origin, prompt-parked, working, degraded done-signal read.

## Acceptance

- [ ] A stopped escalation session (each of the three verbs) whose instance is resolved is reaped after grace; one whose instance is still open is not
- [ ] NULL origin or NULL instance never reaps; prompt-parked never reaps; a degraded done-signal read skips the pulse and reaps nothing
- [ ] autoclose_enabled: false disables the bucket entirely with no other behavior change
- [ ] The reap decision and kill ride one pulse's fresh read

## Done summary
Add the escalation autoclose bucket: unblock/deconflict/resolve sessions are reaped once their block/conflict instance is provably resolved, via an instance-precise fail-closed done-signal read each pulse. Rails, grace, blast-cap and pause-suspension mirror the autopilot bucket.
## Evidence
