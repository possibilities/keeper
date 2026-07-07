## Description

**Size:** S
**Files:** CONTEXT.md, CLAUDE.md, README.md, plugins/keeper/skills/autopilot/SKILL.md, plugins/keeper/skills/watch/SKILL.md

### Approach

Reconcile every surface that states the old behavior — revise clauses in place, never append duplicates, all forward-facing (no fn-ids, no history; the decision rationale already lives in docs/adr/0017). CONTEXT.md: the Needs-human entry's enumeration gains the blocked-task class placed correctly against its count-vs-display language, and the Escalation dispatch entry's "bounded by a global concurrent-session cap" becomes turn-active occupancy phrasing. CLAUDE.md: the autopilot escalation clause gains the two facts an agent would otherwise get wrong — the cap counts working turns, and blocked-suppression rows count on the needs-human surface — as a net-neutral edit (the file is size-gated by `bun scripts/lint-claude-md.ts`; keep it green). Autopilot skill: the hardcoded needs_human family enumeration. Watch skill: the "six needs-human delta types" phrasing and the three repeated filter lists — reconciled against the envelope-only decision (no new watch delta type exists; consolidate the copies if practical). README: one line in the autoclose section noting finished escalation windows are reaped under the same knobs.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- CONTEXT.md:50,56 — the Needs-human and Escalation dispatch entries
- plugins/keeper/skills/autopilot/SKILL.md:105-106 — the family enumeration
- plugins/keeper/skills/watch/SKILL.md:129,134,141,180 — the six-families phrasing + filter lists
- README.md:85-88 — the autoclose section

**Optional** (reference as needed):
- docs/adr/0017-turn-active-escalation-lifecycle.md — the decision record these edits describe
- scripts/lint-claude-md.ts — the CLAUDE.md size gate

### Risks

- The watch skill's filter lists are duplicated 3x — updating some copies and not others is worse than touching none.

### Test notes

`bun scripts/lint-claude-md.ts` green; grep the repo for "six" needs-human phrasings and the old cap wording to confirm no stale copy survives.

## Acceptance

- [ ] CONTEXT.md entries state turn-active occupancy and the blocked-task needs-human class with no contradiction against the count-vs-display language
- [ ] CLAUDE.md autopilot clause reflects the new facts and lint-claude-md stays green
- [ ] Autopilot and watch skill enumerations match the shipped envelope; no stale six-families or filter-list copy remains
- [ ] README autoclose section mentions escalation-window reaping in one line

## Done summary

## Evidence
