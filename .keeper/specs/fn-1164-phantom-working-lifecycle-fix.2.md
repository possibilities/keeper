## Description

**Size:** S
**Files:** src/reducer.ts, test/reducer-lifecycle.test.ts

### Approach

Teach the Notification arm a third discriminated event_type, `idle_prompt`: a
harness-authored positive assertion the session is idle at the prompt. It folds
working to stopped as a QUIESCING transition through the shared lifecycle-stamp
helper from the previous task, behind the same terminal guard and subagent-yield
guard (fresh-anchor + yield-gap bound) as the Stop arm — otherwise it re-opens the
dup-fire window the subagent guard closes. The existing whitelisted kinds
(permission_prompt, elicitation_dialog) keep their stamp-only, never-flips-state
behavior; unknown event_types keep short-circuiting. This is a helper signal only —
claude is the sole harness emitting it — so no other arm may come to depend on it
as the primary done signal.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- docs/adr/0013-jobs-lifecycle-stamp-and-stuck-sentinel.md — layer 2 of the contract
- src/reducer.ts:8811-8848 — the Notification arm and its whitelist comment (currently "does NOT flip state")
- src/reducer.ts:242 — permissionPromptKindFromEventType (decide whether idle_prompt rides it or a separate discriminator; keep the two stamp kinds' behavior byte-identical)
- src/reducer.ts:145 — MAX_STOP_YIELD_GAP_SEC; src/subagent-invocations.ts:245 — findFreshInFlightSubagentAnchor
- The shared stamp helper landed by the previous task — route through it, do not re-implement the gate

**Optional** (reference as needed):
- test/reducer-lifecycle.test.ts — the Stop-arm subagent-yield cases to mirror for idle_prompt

### Risks

- A stale replayed idle_prompt must not become a phantom transition in the other direction — the stamp gate covers it, but test the stale case explicitly.
- The wire string `idle_prompt` should be confirmed against a real claude Notification payload before relying on it (one exists in the live events table).

### Test notes

Cases: idle_prompt folds a working row to stopped; idle_prompt during a fresh
in-flight subagent yield does not flip; a stale idle_prompt (ts behind the stamp)
is swallowed; permission_prompt / elicitation_dialog behavior is unchanged;
unknown event_type still short-circuits. Extend the permutation set from the
previous task with idle_prompt as a member.

## Acceptance

- [ ] An idle-prompt notification on a working, non-terminal row with no fresh in-flight subagent folds the row to stopped
- [ ] An idle-prompt notification during a fresh subagent yield, on a terminal row, or carrying a stale timestamp changes nothing
- [ ] Permission-prompt and elicitation notifications behave exactly as before (stamp annotations only, no state flip)
- [ ] The fold state-machine suite including the extended permutation set is green

## Done summary

## Evidence
