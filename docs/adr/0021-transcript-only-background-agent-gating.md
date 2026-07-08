# 21. Transcript-only background-agent gating for agent-run capture

## Status

Accepted.

## Context

`keeper agent run` (and every panel/pair leg built on it) decides a claude
partner is finished by watching its transcript JSONL for a stop marker, then
captures the final assistant message as the answer envelope. A claude session
can end a turn while background agents it launched (Agent tool,
`run_in_background`) are still working; the harness later injects a
task-notification user message and the session runs further turns that carry
the real answer. A first-stop-wins parser therefore captures an intermediate
answer and reports `completed` — observed in production, where a panel leg's
captured message literally opened "The research is still running, but…" and
the genuine final turn landed seven minutes later, well inside the leg's stop
budget. A second, independent layer of the same incident: no single turn held
the complete report, so even a perfectly-timed wait would have captured a
fragment.

Three signal sources were considered for detecting live background children:

- **keeper's own subagent tracking** (hooks → events log → `subagent_invocations`).
  Rejected: the pair/panel wait stack is deliberately keeper-decoupled — it
  must work with no daemon, no DB, and no hook installation on the partner.
- **Subagent sidecar files** (`<session>/subagents/agent-<id>.{jsonl,meta.json}`).
  Rejected: the meta carries no status field, and deriving completion from a
  child transcript re-derives recursively exactly the fixpoint the harness
  already computes.
- **The parent transcript itself.** Chosen: it durably records the launch
  (a tool_result whose `toolUseResult` object is `status:"async_launched"`
  with an `agentId`), the retirement (queue-operation lines and injected
  task-notification user lines carrying the matching `<task-id>` with a
  terminal status), and the harness's own accounting (`turn_duration` lines
  carry `pendingBackgroundAgentCount` when a turn ends with live background
  children). These shapes are undocumented internals that drift across CLI
  versions, so any parser must fail open.

## Decision

The claude stop scan gates terminality on background quiescence using
transcript lines only. A line-order stateful scan tracks a pending set keyed
by launched `agentId` (retired by matching `<task-id>`; retiring a non-member
is a no-op, which keeps descendant-agent and backgrounded-Bash notifications
from gating). A stop marker is accepted only when the pending set is empty
and no governing `turn_duration` line carries a nonzero
`pendingBackgroundAgentCount`. Both signals fail open: a transcript without
the markers behaves exactly as the first-stop parser did, so shape drift
degrades to the previous behavior rather than a hang, and the existing
stop-timeout ceiling still bounds every wait with a retryable `timed_out`
outcome. Capture prefers the gated stop's own message for claude, so a
later human-resume turn cannot displace the blessed answer; codex, pi, and
hermes capture is unchanged.

The answer-shape layer is a single always-on directive in the `agent run`
prompt composition (a sibling of the read-only directive): the final message
is the captured deliverable and must be one complete, self-contained answer
with background work avoided or folded in before the final turn. The
directive constant is the sole injection mechanism; the panel and pair skill
prose documents the contract but never injects a second variant, so the two
cannot drift.

## Consequences

- A wrong-side failure now lands on the honest side: a session whose
  background child never retires times out retryably with a partial message
  instead of silently reporting a premature answer as `completed`.
- `pendingBackgroundAgentCount` counts the whole descendant tree, so
  count-gating can over-wait when descendants outlive the direct child's
  usefulness; the stop-timeout bounds that case.
- The marker set is version-fragile by design. Parsers match on field
  presence and tolerate absence; the regression floor is the old first-stop
  behavior, never a hang on a background-free session.
- A retired child resumed via SendMessage re-arms real work the pending set
  no longer sees; the directive layer carries that case.
