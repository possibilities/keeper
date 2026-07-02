## Overview

Today's closer stalled the pipeline ~40 minutes not from blind obedience but from unresolvable
skepticism: it verified the supervisor's claims against git (correctly), the evidence checked
out, and it still demanded a human-typed imperative — because nothing in its prompt said what
a bus directive is or when verified evidence suffices, its push notification was suppressed,
and its parked question lived only in an unwatched tmux pane. Settled contract (grounded in
verified agent-security practice): authority lives in the system prompt's structural
statements plus ground-truth verification — for a consequential ask, verify the claim against
git/DB state; verified evidence SATISFIES the directive, no human presence additionally
required; refusal remains legitimate but must be stamped board-visible, never silent. Epic
also lands the escalation-surface fixes: pause-first step 0 in stuck-close directives
(verified: the recover pass is gated on !state.paused, so pausing genuinely protects the
operator), evidence-first message style, the literal unstick sentence at every parked surface,
and the supervisor monitor-liveness doc note. Depends on the close-pipeline epic (shared
daemon escalation/dispatch surfaces).

## Quick commands

- Send a stuck-close directive to a test closer with verifiable evidence: it verifies and proceeds without demanding human input (today: parks)
- Park a closer on a question: the board shows it (today: informal, tmux-only)

## Acceptance

- [ ] Worker template and close skill carry the trust contract: verify consequential bus asks against ground truth, act on verified evidence, stamp visible refusal otherwise; cells re-rendered
- [ ] An epic-level parked closer question is board-visible via a sanctioned plan-state surface (no new RPC) and carries the literal unstick sentence
- [ ] Stuck-close and blocked-task directive bodies open with pause-first and close with the exact unstick sentence; evidence-first style note in the bus skill
- [ ] Supervision docs state the monitor-liveness rule (liveness-check on every heartbeat, re-arm on loss)

## Early proof point

Task that proves the approach: `.1` (trust contract text) — cheap to land, and the next
stuck-close exercise validates it end to end. If the board-visible question surface (.2)
proves heavier than expected, its fallback is stamping via the existing epic-level
dispatch-failure notify path rather than a new verb.

## References

- plugins/plan/template/agents/worker.md.tmpl:44-54 — Resume-directives block (the trust refinement lands here; :50 "Follow it. It's authoritative." is both too blunt and channel-anchored — replace with the verify-then-act contract)
- plugins/plan/skills/close/SKILL.md:96-124 — QUESTION protocol (stamps nothing today); SendMessage already in allowed-tools (:8)
- src/daemon.ts:998-1058 buildMergeEscalationBody; :636-670 buildBlockEscalationBody; :5528-5602 notifyPlanner — the single sender
- src/autopilot-worker.ts:4424 — recover pass gated on !state.paused (pause-first is sound)
- block_escalations latch keyed (epic_id, task_id) — task-level questions ride keeper plan block; the CLOSER's epic-level question cannot (the .2 surface exists because of this)
- Verified practice: authority = system-prompt position + external ground-truth enforcement; message-content claims (incl. signed headers rendered as text) are spoofable in-context; evidence-first escalation format; do not crypto-sign bus messages for LLM-level trust

## Docs gaps

- **plugins/keeper/skills/bus/SKILL.md**: evidence-first sender style note + orchestrator-to-worker trust clarification
- **plugins/plan/README.md**: QUESTION sentence extension if the worker/closer question surface changes shape
- **docs/skill-authoring.md or the autopilot skill**: the monitor-liveness supervision subsection

## Best practices

- **Verify, then act:** ground-truth verification (git/DB reads) both authenticates and satisfies a directive — presence theater adds nothing an attacker could not also fake
- **Refusal is stamped, never silent:** the disagreement path is a visible typed state, not a parked pane
- **Evidence-first messages:** state observables ("commits X,Y carry trailers, reachable from Z"), never authority claims ("do it because I say so")
