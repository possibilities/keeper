# 7. Autonomous escalation dispatch over creator-wake

## Status

Accepted.

## Context

Autopilot has two dead ends a worker cannot resolve on its own: a task stamped
`BLOCKED` after the worker exhausts its own resolution, and a `worktree-merge-conflict`
sticky the tier-1 mechanical resolver declines. Both were answered by waking the work's
creator — the daemon messaged `planner@<epic>` over the Agent Bus, once per incident,
and waited for a human-driven operator session to pick it up.

That path had two structural weaknesses. The creator it reached was frequently the wrong
recipient: a `/plan:work` orchestrator that had already exited, or a session whose
context was stale — so the wake landed on no one, or on someone who had to reconstruct
the incident from scratch. And when the creator was genuinely absent (purged or foreign),
the wake delivered nothing at all and the incident sat silent behind a sticky. The bus
message carried a category and a blocked reason but none of the incident's lineage, so
every recipient re-derived the same context the daemon already had on hand.

## Decision

An escalation dispatches an autonomous session rather than waking the creator. A blocked
task with an escalatable category dispatches an `unblock::<task>` session; a
`worktree-merge-conflict` sticky whose tier-1 resolver reached a terminal decline or
death dispatches a `deconflict::<epic>` session. Each is a fresh sonnet/high session
booting a purpose-built plan skill (`/plan:unblock`, `/plan:deconflict`) that loads a
`keeper escalation-brief <verb>::<id>` envelope — incident details, ids, creator lineage
(a closer creator resolved back to the original creator, with session ids and transcript
paths for both), and transcript pointers — and resolves the incident without the
creator's context.

The escalation session's authority is bounded by its skill's guardrails, not a human's:
it settles what it can prove and stamps `BLOCKED` on anything needing judgment beyond its
remit (security-critical code, incompatible business logic, intents that cannot coexist).
Transcripts enter the session as labeled untrusted data under a least-privilege tool
allowlist — a cheaper model means a tighter allowlist, not a looser one.

The human is notified exactly once, via botctl, and only at a terminal outcome: when an
escalation session itself declines or dies. Two categories never escalate at all —
`TOOLING_FAILURE` and an absent or unparseable category are a surface-and-stop that mints
a silent, operator-visible sticky suppression instead of dispatching.

Once-only semantics ride staged once-markers on the incident row rather than agent
self-narration. The block path stages `block_escalations` latch states through dispatch
to a terminal `human_notified_at` stamp; the merge path stages `resolver_dispatched_at`
→ `merge_escalated_at` → `human_notified_at` columns on the sticky `dispatch_failures`
row, each an independent once-latch. A global cap bounds concurrent escalation sessions
and per-epic serialization bounds unblock fan-out; `retry_dispatch` (for the merge sticky)
and the leave-blocked clear (for the block latch) re-arm the whole marker chain at null.

## Consequences

- The creator is out of the loop entirely: escalations no longer depend on a live,
  in-context creator session, so a stale or absent creator never strands an incident.
- Agent authority is bounded by skill guardrails and least-privilege tool frontmatter,
  and every commit/retry gates on parsed exit codes and git/keeper output, never on the
  session's self-narration.
- The human surface shrinks to a single terminal page per incident — an escalation the
  autonomous session could not settle — instead of a wake on every block or conflict.
- Once-only delivery is a property of the staged markers, so a daemon restart re-derives
  the same in-flight state and never double-dispatches or double-pages.
- A category the daemon refuses to escalate stays operator-visible as a sticky
  suppression rather than paging anyone, keeping the un-escalatable failures loud on the
  board without noise.
