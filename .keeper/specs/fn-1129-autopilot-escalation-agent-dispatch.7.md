## Description

**Size:** S
**Files:** CLAUDE.md, CONTEXT.md, docs/plugin-composition-map.md, docs/adr/0006-autonomous-escalation-dispatch.md, plugins/plan/skills/plan/references/operator-orchestration.md, plugins/plan/README.md

### Approach

Prune-and-revise the operator docs to the new escalation shape, forward-facing only. CLAUDE.md autopilot paragraph: the merge-escalation sentences now describe dispatching deconflict::<epic> behind the resolver verdict plus the terminal human-notify marker; keep the column-not-latch and retry_dispatch re-arm invariants; consolidate rather than append (the lint gate binds). operator-orchestration.md "Helping a blocked work agent": replace the wake-the-creator procedure and its verbatim message quote with the unblock:: dispatch flow — the human's surface is now the terminal notification. plugin-composition-map.md: add the two launch producers beside resolve:: with a note on the separate escalation preset. plan README Command Map: add escalation-brief; keep the keeper plan unblock board verb clearly distinct from the unblock skill. CONTEXT.md glossary: entries for Escalation dispatch, Unblock session, Deconflict session; sharpen the Resolver entry with the boundary (resolver = tier-1 mechanical settler; deconflict = the context-loaded tier after the resolver declines). ADR 0006 in the existing template (# N. Title / ## Status / ## Context / ## Decision, cf. 0003): decision — escalations dispatch autonomous sessions carrying an assembled brief, with the human notified only at terminal decline/death; context — the creator-wake path delivered to sessions that had gone stale or absent and carried no context for anyone else; consequences — the creator is out of the loop, agent authority is bounded by skill guardrails, once-only semantics ride staged markers.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- CLAUDE.md autopilot paragraph (the worktree/merge-escalation narration) and scripts/lint-claude-md.ts (keep green)
- plugins/plan/skills/plan/references/operator-orchestration.md — the "Helping a blocked work agent" section
- docs/adr/0003 and docs/adr/0005 — the ADR template in use
- CONTEXT.md — the Worktree-and-merge section's Resolver entry

**Optional** (reference as needed):
- docs/plugin-composition-map.md:77-82 — launch-producer inventory; plugins/plan/README.md — Command Map

### Risks

- The CLAUDE.md size/re-narration lint gate: consolidate and delete as readily as add.

### Test notes

bun scripts/lint-claude-md.ts green; grep the docs tree for leftover planner@ escalation narration presented as current behavior.

## Acceptance

- [ ] No repo doc still describes the creator-wake escalation as current behavior, and the CLAUDE.md lint gate passes
- [ ] CONTEXT.md defines the two new session types and the resolver/deconflict boundary, and the unblock board-verb/skill homonym is disambiguated where both appear
- [ ] docs/adr/0006 records the autonomous-escalation decision in the existing template

## Done summary

## Evidence
