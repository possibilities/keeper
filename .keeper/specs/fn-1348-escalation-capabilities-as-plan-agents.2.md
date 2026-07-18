## Description

**Size:** S
**Files:** plugins/plan/skills/deconflict/SKILL.md, plugins/plan/skills/unblock/SKILL.md, plugins/plan/skills/repair/SKILL.md

### Approach

Rewrite the three hand-authored escalation skills (verified hand-authored — no managed-file sidecar) as thin wrappers: each loads its incident context exactly as today (escalation-brief CLI), spawns the corresponding plan agent as a Task subagent with the data-delimited incident, relays the typed receipt, and on a resolved receipt performs the same close-out the skill performs today (for deconflict, the `keeper autopilot retry` clear of its own sticky). The wrappers stay dual-use: a human can invoke them directly, and a legacy autopilot-dispatched escalation session booting the skill gets identical behavior with the reasoning now confined to the subagent. No daemon changes here; the legacy dispatch path itself retires in the final epic.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/skills/deconflict/SKILL.md, unblock/SKILL.md, repair/SKILL.md — current phase structure, guardrail blocks, and close-out verbs to preserve in wrapper form
- plugins/plan/skills/work/SKILL.md — the Task-spawn + receipt-parse idiom the wrappers mirror (worker spawn and audit-gate patterns)

**Optional** (reference as needed):
- cli/escalation-brief.ts — envelope fields the wrapper forwards into the data-delimited section

### Risks

- A wrapper that forwards the brief as instructions instead of data reopens the injection surface the agents' contract closes — keep the delimiting explicit

### Test notes

No automated suite covers skill prose; verification is behavioral — boot each wrapper against a synthetic incident brief in a sandbox checkout and confirm the receipt relay and close-out verbs fire.

## Acceptance

- [ ] Each of the three skills delegates its reasoning to the corresponding plan agent and relays a typed receipt
- [ ] A legacy escalation session booting any of the three skills completes its incident flow unchanged, including the sticky-clearing close-out on success
- [ ] Human direct invocation of each skill still works

## Done summary
Rewrote deconflict/unblock/repair skills as thin Task-spawn wrappers over plan:deconflicter/unblocker/repairer, relaying typed receipts and preserving today's success close-out (retry, resume/cold-dispatch, unblock+resume fan-out) and decline paging.
## Evidence
