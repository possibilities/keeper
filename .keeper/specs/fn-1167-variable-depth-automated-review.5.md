## Description

**Size:** S
**Files:** src/daemon.ts, test/daemon.test.ts, plugins/keeper/skills/autopilot/SKILL.md

### Approach

The daemon's block-escalation producer learns the two audit categories. A block whose reason opens with AUDIT_READY is self-handled: no page while the owning orchestrator job is live; if the orchestrator dies with the task still parked, page planner after a short grace window exactly like any block (the recovery path — a planner resolves it by running or re-dispatching the audit). AUDIT_SEVERE pages immediately through the unchanged existing path. Follow the producer's existing change-gate discipline (first appearance + reason-change, no per-cycle re-emits). The autopilot skill's close-audit sentence updates to name variable depth and the per-task gate in one line each — forward-facing, no history.

### Investigation targets

*Verify before relying.*

**Required**:
- src/daemon.ts — the block-escalation producer (category parsing, TOOLING_FAILURE skip precedent, notify-once column discipline) and job-liveness probes available to it
- plugins/keeper/skills/autopilot/SKILL.md — the close-audit sentence and escalation section

### Risks

- Liveness probing must stay producer-side (producers probe, folds never do) — the orchestrator-alive check rides the existing jobs projection, not a new probe class.

### Test notes

Daemon tests drive the producer with synthetic rows: fresh AUDIT_READY + live job → no page; dead job past grace → one page; AUDIT_SEVERE → immediate page; change-gate suppresses identical re-emits.

## Acceptance

- [ ] A fresh AUDIT_READY block with a live orchestrator never pages; a dead orchestrator past the grace pages exactly once; AUDIT_SEVERE pages like any block
- [ ] Re-emits are change-gated per the producer's existing discipline
- [ ] The autopilot skill describes the variable-depth close audit and the per-task gate in present tense
- [ ] Daemon suite green

## Done summary
Daemon block-escalation producer learns the audit categories: AUDIT_READY blocks self-handle (no page) while the owning work/close orchestrator is live or within a post-death grace, escalating like any block only past grace after a witnessed orchestrator death; AUDIT_SEVERE pages immediately via the existing path. Autopilot skill documents the variable-depth close audit and the per-task gate.
## Evidence
