## Description

**Size:** S
**Files:** src/await-conditions.ts, the `keeper status` in_flight computation, test/await-conditions.test.ts

### Approach

Reproduce first: confirm `keeper status`'s `in_flight.running_jobs` counts the
supervising interactive session itself (a `jobs` row in `state='working'`), so
"wait until running_jobs==0" never reaches 0 while an agent drives a maintenance
window. Expose an unambiguous plan-worker-only signal: either a distinct
`in_flight` field counting only dispatched plan-worker jobs (`work::`/`close::`/
resolver/repair verbs), or a new `keeper await` condition (e.g. `no-plan-workers`)
in `src/await-conditions.ts` that is true iff no plan-worker dispatch is active —
excluding interactive sessions. Keep it a read-time projection derivation (never
inside a fold — re-fold determinism). This is the gate the wrapper (task .2)
depends on to know the board is safe to stop.

### Investigation targets

*Verify before relying — the repo moves.*

**Required:**
- src/await-conditions.ts — where `keeper await` conditions live (e.g. `monitorRunningState`); add the new condition here
- the `keeper status` envelope builder that computes `in_flight.running_jobs` (locate via repro) — distinguish plan-worker jobs from interactive sessions

### Test notes

Unit-test the new count/condition: an interactive `working` session does NOT count; an active plan-worker dispatch DOES; zero plan workers → the drained signal is true.

## Acceptance

- [ ] A signal exists that reports plan-worker activity excluding the supervising/interactive session.
- [ ] The signal reads 0 / drained when only interactive sessions are active, and non-zero when a plan worker is dispatched.
- [ ] The derivation is read-time (not inside a fold).

## Done summary
Added isBoardWorkJob/boardWorkIdleState in src/await-conditions.ts and an additive keeper status in_flight.board_work_jobs field, both excluding interactive/supervising sessions from plan-worker activity counts.
## Evidence
