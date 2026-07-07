## Description

**Size:** M
**Files:** src/await-conditions.ts, cli/await.ts, test/await-conditions.test.ts

### Approach

Add seven await conditions: six per-signal tokens (dead-letter, block-escalation, parked-question, stuck-dispatch, finalize-non-ff, instant-death-wall) and the umbrella needs-human. All are level-triggered presence predicates — pure functions in src/await-conditions.ts consuming the shared projector's classification (task 1): the dispatch trio and the umbrella fire on the operator-jam class only, and the umbrella total honors the subset non-double-count rule. Each condition accepts an optional `since:<signature>` segment mirroring the `changed since:R` grammar: with an anchor, the condition is met only when the current needs-human signature differs from the anchor, and every met envelope carries the current signature — this is the supervisor's re-arm anti-spin mechanism (a still-present, already-triaged rung-4 signal does not instantly re-fire, while a genuinely new signal landing beside it does). Baselines follow the existing BoardSlotState machinery: captured once, never re-anchored on reconnect. The includeDispatchFailures opt-in is DERIVED from the parsed condition set (union of drained --fail-on-stuck, the dispatch trio, and the umbrella — generalizing the gate task 2 left narrow), so mis-wiring is structurally impossible; dead-letter/block-escalation/parked-question ride the always-folded snapshot members and must not open the fold. Add an internal invariant: a predicate that needs dispatch-failure rows with no open fold throws a programming error rather than waiting forever. Wire the standard arms: parse branches, ConditionSegment union members, slot state, stream-need flags, evalBoardSlot arms, both help registers (HELP and AGENT_HELP), and the unknown-condition error list. Document composition with --require-transition (it applies per-slot as today; the signature anchor is the preferred re-arm idiom for these conditions).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/await.ts:234-250 — ConditionSegment union (the changed since:R member is the anchor grammar precedent); :426-607 — parse branches and the unknown-condition list; :839-859 — BoardSlotState baseline fields; :896-958 — stream-need flags and the :943 opt-in gate to generalize; :1581-1637 — evalBoardSlot; :1784-1802 — pass-1 dispatch
- src/await-conditions.ts — the pure predicate family style ((inputs) => AwaitState); :1032-1040 isJamReason; :1144-1215 the edge predicates; changedSignature and its baseline-once discipline
- src/needs-human.ts — the projector's classification and signature hash (task 1); consume, never re-derive
- cli/await.ts:1830-1833 — the --require-transition knob whose composition must be documented

**Optional** (reference as needed):
- cli/descriptor.ts:622-666 — the await flags descriptor; since: is a condition segment, not a flag, so this should need no change (verify)

### Risks

- Predicates bypassing the projector re-open the broad-vs-jam drift the shared module exists to close.
- Signature instability under row reordering breaks the anchor (sort before hashing — pinned by task 1's tests, but the await integration must not re-hash differently).
- Arming a per-signal token AND the umbrella yields two wakes for one event — intended user choice; document it in AGENT_HELP rather than suppressing.

### Test notes

Fixture tests beside the existing predicate suite: presence per family, jam-class filtering (an occupancy row never satisfies stuck-dispatch), subset non-double-count in the umbrella, signature anchoring (met-at-arm with matching anchor waits; new signal beside a persisting one fires), baseline retention across a simulated reconnect re-paint, and the derived opt-in (a dead-letter-only invocation must not open the dispatch-failures fold).

## Acceptance

- [ ] keeper await supports the six per-signal tokens and the umbrella needs-human, level-triggered, ANDable, documented in both help registers
- [ ] The dispatch trio and umbrella fire on the operator-jam class only, deriving from the shared projector
- [ ] A since:<signature> segment makes a met-at-arm condition wait for a genuinely different signal set, and every met envelope carries the current signature
- [ ] The dispatch-failures opt-in derives from the parsed condition set; signal-only invocations never open the fold, and a predicate can never silently wait on an unopened fold
- [ ] Fixture tests cover presence, jam filtering, subset rules, signature anchoring, and reconnect baseline retention

## Done summary

## Evidence
