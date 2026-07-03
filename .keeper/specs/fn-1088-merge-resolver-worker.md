## Overview

Today every worktree merge conflict waited for a live supervisor or human; the directive-driven
manual flow worked but is the drain bottleneck when nobody is watching. This epic lets
autopilot dispatch a resolver worker on a merge-conflict sticky, with authority deliberately
narrower than a human's: mechanically-clear resolutions only (preserve both intents, epic
tests must pass, the close audit still runs behind it); anything state-machine, schema,
security, or transaction-boundary shaped is stamped BLOCKED with the literal unstick sentence
and left for the human — the existing escalation continues unchanged in that case. Depends on
the dissolution epic (resolver workers launch under keeper-owned permission posture) and the
quota epic (shared reconciler/daemon/reason-vocabulary files this session).

## Quick commands

- Seed a mechanically-clear conflict on a scratch epic lane: resolver lands the merge, tests pass, retry fires, close proceeds
- Seed a schema-shaped conflict: resolver stamps BLOCKED with the unstick sentence; sticky + escalation unchanged

## Acceptance

- [ ] A worktree-merge-conflict sticky dispatches ONE resolver attempt (change-gate/notify-once disciplines respected; no resolver churn loop)
- [ ] Resolver resolves only mechanically-clear conflicts (both-intents rule, epic tests green) then commits and fires retry; everything else stamps BLOCKED with the exact unstick sentence
- [ ] Human escalation path unchanged when the resolver declines or fails; the close audit still gates the merged result
- [ ] Instant-death breaker applies to resolver dispatches like any key (no wall churn)

## Early proof point

Task `.1` — the dispatch wiring + prompt against a seeded scratch conflict. If one-attempt
discipline proves hard at the reconciler seam, fall back to daemon-sweep dispatch (the
merge-escalation sweep already has notify-once plumbing to piggyback).

## References

- The merge-escalation machinery: sticky worktree-merge-conflict on close::<epic>, merge_escalated_at notify-once column, buildMergeEscalationBody (pause-first + unstick landed by the trust epic) — the resolver is a new consumer of the same trigger, not a replacement
- The landed trust contract: verify-then-act, stamped refusal, unstick sentences — the resolver prompt's backbone
- Today's three manual resolutions (install.sh fan-in, keeper.ts help-block fan-in, autopilot-SKILL finalize) — the mechanically-clear exemplars; the guardrail classes come from the directive's own GUARDRAIL text
- Dispatch vocabulary: resolver runs as a first-class dispatch key (e.g. resolve::<epic>) so jobs/reaps/breakers all apply

## Docs gaps

- **plugins/keeper/skills/autopilot/SKILL.md**: escalation section gains the resolver-attempt step in the conflict flow
- **CLAUDE.md**: one line only if the resolver changes an invariant-adjacent rule (lint-gated)
