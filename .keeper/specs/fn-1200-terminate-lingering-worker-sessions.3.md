## Description

**Size:** M
**Files:** src/readiness-inputs.ts, src/exit-watcher.ts, test/readiness.test.ts, test/exit-watcher.test.ts

### Approach

A done task's verdict must not oscillate with session-liveness churn: in the incident, a completed task's verdict flapped completed↔running while its own worker job sat stopped with zero discharge counters, re-deriving against flapping liveness attributed from sibling activity on the shared lane. Locate where the done-AND-idle verdict attributes "owning subagent" liveness, and re-key it on stable terminal evidence — the worker's own job reaching a proven-terminal state (exit-watcher verdict, SubagentStop/worker_phase) — rather than any signal that can flap after terminality (live pane reads, session working/stopped transitions of other jobs, monitor wake churn). Terminality is a one-way latch per owning job: once the owning session is proven dead/idle and the task is done, the verdict stays completed regardless of unrelated churn. Replay the incident shape as the regression.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- The done-AND-idle verdict derivation (start from src/readiness-inputs.ts and the serve-path verdict composition; CONTEXT.md Phantom-working names the class)
- src/exit-watcher.ts — the terminal-verdict source and what re-fires job state transitions
- cli/await.ts complete-condition notes (fn-1015) — the await consumer whose semantics must stay done-AND-idle

**Optional** (reference as needed):
- Incident regression shape: done task, its worker job stopped with zero git discharge counters, an active sibling worker on the shared epic lane — verdict must hold completed

### Risks

- Over-latching could mask a genuine post-done regression (a done task whose lane later reopens); scope the latch to the owning job's terminality, not the task id forever.
- The await-complete consumer must not fire earlier than today — stability work must not weaken the done-AND-idle bar, only stop its oscillation.

### Test notes

Pure verdict tests replaying the incident shape and a control (owning job genuinely re-activated → verdict may legitimately leave completed); assert no flap across repeated derivations with churning sibling liveness inputs.

## Acceptance

- [ ] The incident shape (done task, terminally-stopped clean worker, churning sibling liveness) derives a stable completed verdict across repeated evaluations
- [ ] A genuinely re-activated owning job still surfaces (no permanent latch on the task id)
- [ ] Await-complete semantics are unchanged or strictly less flappy (never earlier-firing)
- [ ] keeper fast suite green

## Done summary

## Evidence
