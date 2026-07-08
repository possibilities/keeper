## Overview

`keeper agent run` and every panel/pair leg built on it capture a claude partner's
answer by watching its transcript for a stop marker; a partner that launches
background agents can end a turn early, and the wait then captures an intermediate
answer as completed. This epic gates claude stop acceptance on background
quiescence (a settled stop) using transcript-only signals, couples capture to the
gated stop, and adds a final-message contract directive so partners consolidate
background results into one self-contained final message. End state: a
backgrounding claude leg either returns its genuine consolidated answer or times
out retryably — never a silent premature capture.

## Quick commands

- bun test test/agent-transcript-background.test.ts test/agent-byte-pin.test.ts — proves the gate, capture coupling, and directive composition in the pure tier

## Acceptance

- [ ] A claude agent-run leg with live background agents never reports completed until every launched agent retires; an unresolved background agent ends in a retryable timed-out outcome carrying the partial message.
- [ ] Background-free claude sessions and codex/pi/hermes legs behave exactly as before.
- [ ] Every agent-run partner prompt carries the final-message consolidation contract, and the pair/panel skill prose documents it.

## Early proof point

Task that proves the approach: ordinal 1 (the wait gate). Its incident-spine
fixture (background launch, premature end_turn, retire, later stop) must go red
under the current first-stop parser and green under the gate. If it fails:
fall back to count-only gating on the turn-duration pending-background count and
re-derive the marker set from additional real transcripts.

## References

- docs/adr/0021-transcript-only-background-agent-gating.md — the recorded detection + single-source-directive decision
- CONTEXT.md — Background agent / Settled stop glossary entries
- Incident ground truth: ~/.claude/projects/-Users-mike-code-keeper/72ab7971-1410-478d-b697-b886cfe5baf6.jsonl (panel leg claude-opus: premature capture at the first end_turn, real answer post-notification; async_launched marker, queue-operation retires, injected task-notification, pendingBackgroundAgentCount all observable here)
- Upstream corroboration: anthropics/claude-code issue #47936 — async subagents stopping early
- Epic-scout: no dependencies or overlaps with open epics (fn-1174/1175/1176/1179/1180 write disjoint surfaces)

## Docs gaps

- **plugins/keeper/skills/pair/SKILL.md**: revise capture-timing prose in place (settled stop) and describe the final-message directive beside the read-only posture — covered by task ordinal 2
- **plugins/plan/skills/panel/references/panel.md**: document the leg output-shape contract with the code directive as the single injection source — covered by task ordinal 2

## Best practices

- **Id-keyed quiescence, never a bare counter:** termination detection over launch/retire edges must match specific ids; a counter read as zero is not a safe quiescence signal [termination-detection literature]
- **Fail-open against schema drift:** the marker fields are undocumented CLI internals; match on presence, tolerate absence, skip malformed lines without aborting the scan [schema-evolution guidance]
- **Complete-line-only JSONL reads:** a reader concurrent with an appender can observe a partial final line; parse only newline-terminated lines and let the next poll pick up the remainder [POSIX write/read atomicity]
- **Substring pre-filter before JSON.parse:** the wait re-parses a growing transcript every 250ms; an indexOf gate on marker substrings keeps uninteresting lines cheap [hot-path parse avoidance]
