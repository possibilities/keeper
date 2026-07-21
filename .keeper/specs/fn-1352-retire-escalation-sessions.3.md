## Description

**Size:** S
**Files:** CLAUDE.md, README.md, CONTEXT.md, docs/plugin-composition-map.md, docs/problem-codes.md, docs/adr/

### Approach

Reshape every doc surface to state the in-session model, pruning as much as adding: CLAUDE.md's hook list and autopilot worktree paragraph collapse to the incident/claim/grant model with a net size reduction; README's composition summary re-counts; the plugin-composition-map's escalation-dispatch block rewrites around confined subagents and grants; problem-codes examples that cite escalation dispatch rows update. CONTEXT.md retires or redefines the escalation-session vocabulary — Escalation dispatch, Unblock session, Deconflict session, Repair session, Resolver, Board-work session, Block instance, and the dispatch-table avoid-list — and adds Incident, Grant, Trunk lease, Fencing token, Typed receipt, and Attachment lease in the fixed term-definition-avoid shape. Fully superseded ADRs (autonomous escalation dispatch, both escalation-lifecycle and trunk-repair records, the work-verb escalation record) move to superseded/ with pointers to the in-session record; partially affected records gain amendment notes. Every statement is forward-facing present tense.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- CLAUDE.md hook-list and autopilot sections — the collapse targets, already partially updated by the groundwork epic
- CONTEXT.md:51-83 and :113 — every term being reshaped
- docs/plugin-composition-map.md:153-191 — the escalation block
- docs/adr/superseded/ — the move convention (existing precedent in the tree)

**Optional** (reference as needed):
- docs/problem-codes.md — the example rows citing dispatch.unblock

### Risks

- The glossary must describe landed behavior only — this task lands after both retirement tasks, and any statement about machinery that still exists in code is a defect

### Test notes

Both lint gates green; a grep sweep proving no doc surface names the retired session kinds outside ADR history and superseded records.

## Acceptance

- [ ] Every non-ADR doc surface describes only the in-session escalation model, in present tense, with CLAUDE.md net smaller and both lint gates green
- [ ] CONTEXT.md carries the new vocabulary and none of the retired session definitions
- [ ] Fully superseded ADRs live under superseded/ with pointers; amended records carry notes
- [ ] No doc surface outside docs/adr names the retired session kinds

## Done summary
Reshaped CLAUDE.md, README.md, CONTEXT.md, plugin-composition-map.md, and problem-codes.md to describe only the landed in-session incident/grant model; moved the four fully superseded ADRs (0007, both 0017s, 0039) to superseded/ with pointers to ADR 0089 and amended 0049/0070. Discovered task 2's collapse commit had landed on its own unmerged lane; fast-forwarded it in before writing docs so the glossary reflects actual code, not stale plan-state claims.
## Evidence
