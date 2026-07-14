## Description

**Size:** S
**Files:** CONTEXT.md

### Approach

Add glossary entries to CONTEXT.md for the agent-interaction vocabulary, following the strict `**Term**: role-and-behavior definition. Avoid: rejected, synonyms.` shape (concepts only — no files, code, or history): **Elicit-an-answer surface** (an agent launch whose contract is a captured deliverable — pair and panel); **Delegate-work surface** (an agent launch that hands work to a session with no deliverable contract — handoff, dispatch, autopilot workers); **Partner** (a pair session: an elicit-an-answer agent that terminates with an envelope deliverable, resumable by name, reached over the Agent Bus while live); **Handoff** (a delegated parked session carrying an event-sourced brief, no deliverable by default); **Launch handle** (the caller-supplied stable identifier of a launched, possibly-dead agent — dedup key, durable-state key, and resume-if-dead / message-if-live routing anchor — whose idempotency scope is per-surface). State each surface's handle scope inside the Launch handle entry in concept terms (partner names, handoff slugs, panel display slugs + opaque request identity). Place entries in or adjacent to the existing "Panels and launch triples" section; stay consistent with the existing Panel/Panel leg/Launch triple/Agent Bus entries and do not duplicate them.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- CONTEXT.md:104-151 — the Bus/session and Panels sections these terms join; match register and format
- plugins/keeper/skills/pair/SKILL.md and plugins/keeper/skills/handoff/SKILL.md — verify the definitions match live skill behavior (resume-by-name, live-target-refusal, park-at-confirm)

**Optional** (reference as needed):
- src/agent/dispatch.ts — resume semantics grounding the Partner definition
- src/handoff-slug.ts — slug semantics grounding the Handoff/Launch handle scope claims

### Risks

- A definition that contradicts live behavior is worse than no entry; verify each behavioral claim against the current code before writing it.

### Test notes

No test surface; `bun scripts/lint-claude-md.ts` guards CLAUDE.md only. Review the diff for pure-glossary discipline (no file paths, no implementation detail).

## Acceptance

- [ ] CONTEXT.md defines Elicit-an-answer surface, Delegate-work surface, Partner, Handoff, and Launch handle in the standard Term/Avoid shape
- [ ] The Launch handle entry names each surface's idempotency scope in concept terms
- [ ] No existing entry is duplicated or contradicted; entries contain no file paths, code, or history

## Done summary

## Evidence
