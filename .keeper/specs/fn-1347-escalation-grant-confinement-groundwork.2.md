## Description

**Size:** S
**Files:** plugins/keeper/plugin/hooks/wrong-tree-guard.ts, plugins/keeper/plugin/hooks/wrapped-guard.ts, plugins/keeper/plugin/hooks/grant-guard.ts, test/wrong-tree-guard.test.ts, test/wrapped-guard.test.ts, test/grant-guard.test.ts

### Approach

Wire exact-grant overrides into the two env-keyed guards without weakening their default postures. wrong-tree-guard: a valid grant whose writable root covers the target lifts the own-lane-only restriction for exactly that target (a granted repairer or closer-integrate writing the shared checkout from a lane-marked session), while protected-path denials and the fail-open posture stay intact. wrapped-guard: a valid grant for the exact escalation agent_type lifts the blanket source-edit denial for THAT subagent only — the wrapped courier and every other subagent under a wrapped root stay fully denied. Both overrides read the leaf exclusively through the grant-leaf module's derivation + validating reader; the override check runs before the blanket deny and short-circuits allow only on a full-tuple match.

In grant-guard, scope incident-clearing verbs: `keeper autopilot retry <verb>::<id>` (and any future incident release verb) is allowed for an escalation-typed subagent only when the target id matches the grant's incident id — a granted agent can clear its own incident, never a sibling's.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/plugin/hooks/wrong-tree-guard.ts:526-551 — classifyTarget ladder the override slots into (own-lane allow at the toplevel comparison)
- plugins/keeper/plugin/hooks/wrapped-guard.ts — the blanket edit-denial arms and the Bash positive allowlist the override must bound
- plugins/keeper/plugin/hooks/escalation-guard.ts predecessors in git history for the retry-verb allowance shape (`keeper autopilot retry` handling)

**Optional** (reference as needed):
- test/wrong-tree-guard.test.ts, test/wrapped-guard.test.ts — existing suites to extend with granted/ungranted matrices

### Risks

- An override ordered after the blanket deny is dead code; ordered before but matched loosely it is a bypass — the full-tuple match and protected-path carve-out are both load-bearing

### Test notes

Extend each guard suite with a granted-vs-ungranted matrix: granted repairer writes shared checkout (allow), granted agent writes outside root (deny), courier with sibling's grant (deny), expired/mismatched grants (deny), retry against own vs foreign incident id (allow/deny). Pure in-process, synthetic leafs, named gates.

## Acceptance

- [ ] A tuple-matched grant admits writes into its granted root through both wrong-tree-guard and wrapped-guard while every ungranted, expired, mismatched, or out-of-root case keeps today's denial behavior
- [ ] The wrapped courier remains fully edit-denied even when a sibling subagent holds a grant
- [ ] Incident-clearing verbs are admitted only against the grant's own incident id
- [ ] All three guard suites pass via named test gates

## Done summary
Scoped keeper autopilot retry to the grant's own incident id in grant-guard (a confined subagent re-arms its own incident only), and extended the wrong-tree/wrapped guard suites with synthetic-leaf granted-vs-ungranted matrices plus the courier-under-sibling-grant deny case. All three guard suites and the full root gate are green.
## Evidence
