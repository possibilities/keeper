## Description

**Size:** S
**Files:** plugins/plan/agents/epic-scout.md, plugins/plan/skills/plan/SKILL.md

### Approach

Teach the planning layer that the schema ladder is a singleton resource. epic-scout.md:
add a schema-singleton signal to the overlap detection guidance (an epic whose specs imply
a SCHEMA_STEPS/ladder bump) and to the Overlaps output bucket, so two open migration-
bearing epics surface as an overlap the planner wires a dep edge for. The plan skill:
extend the same-session multi-epic overlap note (the epic-scout blind-spot paragraph in
Phase 6) to name the schema ladder explicitly, and add one line to the spec-authoring
guidance: a migration task's spec says the version is assigned at merge time — specs never
hardcode "the next" number. Keep both edits tight and in each file's existing voice; the
plan skill file is long and load-bearing, so additions are surgical, not structural.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/agents/epic-scout.md — overlap signals + four-bucket output contract
- plugins/plan/skills/plan/SKILL.md — Phase 6 same-session sibling paragraph + Phase 5e spec guidance

**Optional** (reference as needed):
- src/db.ts SCHEMA_FINGERPRINT doc comment — the singleton rationale to cite in one clause

### Risks

- epic-scout is blind to same-session siblings by design — the SKILL.md paragraph is where that gap is covered; do not pretend the scout can see them.

## Acceptance

- [ ] epic-scout's charter names a ladder bump as an overlap signal and shows it in the Overlaps bucket contract
- [ ] The plan skill's same-session paragraph and spec-authoring guidance carry the singleton + version-at-merge conventions
- [ ] Both files read coherently end-to-end; no contradiction with the resolver-charter wording

## Done summary
Taught planning layer the schema ladder is a singleton resource: epic-scout gains a schema-bump overlap signal in both its guidance and Overlaps output bucket; the plan skill's same-session paragraph and spec-authoring guidance now name the ladder explicitly and require version-at-merge wording instead of hardcoded next-version numbers.
## Evidence
