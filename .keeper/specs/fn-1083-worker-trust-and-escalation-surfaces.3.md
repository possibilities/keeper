## Description

**Size:** S
**Files:** src/daemon.ts (buildMergeEscalationBody, buildBlockEscalationBody), docs/skill-authoring.md or plugins/keeper/skills/autopilot/SKILL.md, test/ (body snapshot tests)

### Approach

Directive-text surgery, verified sound: the recover pass runs only when autopilot is
unpaused (autopilot-worker.ts:4424), so make step 0 of buildMergeEscalationBody
(daemon.ts:998-1058) "pause autopilot (keeper autopilot pause) — the recover sweep races
your manual merge otherwise," and mirror where applicable in buildBlockEscalationBody
(:636-670). Both bodies close with the literal unstick command line the operator runs when
done (retry + play). Restyle both evidence-first (state the failing observable and the
verification commands; drop any authority framing). Add the supervisor monitor-liveness
subsection to the supervision doc surface (skill-authoring guide or the autopilot skill —
whichever reads as the operator runbook): long-running supervision liveness-checks its
monitors every heartbeat and re-arms on loss; daemon restarts and session churn kill
watch consumers silently, and re-attach is the consumer's job.

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:998-1058, 636-670 — the bodies; pure string builders, snapshot-testable
- The directive text as received today (inventory items 4/13) — what confused and what worked

### Risks

- These bodies are read by unattended agents — keep them imperative and short; every added line is a per-escalation token cost.

### Test notes

Snapshot tests on both builders (pause-first line present, unstick line present); lint
green on any CLAUDE.md-adjacent doc edit.

## Acceptance

- [ ] Both directive bodies open pause-first and close with the literal unstick commands; evidence-first tone
- [ ] Monitor-liveness subsection landed in the operator-facing doc
- [ ] Snapshot tests pin both bodies

## Done summary
Restyled buildMergeEscalationBody and buildBlockEscalationBody pause-first + evidence-first, closing with the literal unstick commands (retry+play / play). Added the monitor-liveness supervision subsection to the autopilot operator runbook and pinned both bodies with snapshot tests.
## Evidence
