## Description

**Size:** S
**Files:** README.md, CLAUDE.md (symlinked as AGENTS.md)

### Approach

Surgical doc edits to reflect what shipped. Per docs-gap-scout's findings: NO new sections, NO narrative walkthrough, NO new DO NOT entries. Extensions to existing enumerations and one new query in the Inspect section.

**`README.md`** — five in-place edits:
1. "What keeper is" sparse-signals paragraph (around lines 27-31): add `events.tool_use_id` as a third sparse top-level column alongside `slash_command` and `skill_name`. Same column-name + populating-events + partial-index-name pattern.
2. "Two collections register today" sentence in "What keeper is" (around lines 51-57): revise in place to name `subagent_invocations` as the third collection.
3. Same "Two collections" language in Architecture section (around lines 314-327): revise in place to match.
4. Architecture section events-table description (around lines 303-309): name `events.tool_use_id` in the existing sparse-columns sentence.
5. Inspect section (around lines 389-424): add two queries in the existing terse comment-then-query style — (a) a recent per-job timeline `SELECT FROM subagent_invocations`, (b) `SELECT COUNT(*) FROM events WHERE tool_use_id IS NOT NULL`.

**`CLAUDE.md`** — one in-place edit inside Event-sourcing invariants:
- "cursor + projection advance in the SAME `BEGIN IMMEDIATE` transaction" bullet's parenthetical listing of projections (`jobs`/`epics`): add `subagent_invocations`. One-line edit.

The "hook is the sole writer of hook events" bullet does NOT need an edit: SubagentStart/SubagentStop/PostToolUse:Agent are existing hook events (not new synthetic events). Verified against docs-gap-scout finding.

### Investigation targets

**Required** (read before coding):
- `README.md` (entire file) — locate the five insertion points; verify exact line numbers against the post-fn-598 merged state (fn-598's task .6 also revises the "sparse signals" enumeration, so the exact column count and line numbers may shift).
- `CLAUDE.md` Event-sourcing invariants section — locate the parenthetical to extend.

### Risks

- **Doc drift if fn-598's task .6 lands a different enumeration shape.** fn-598 revises the same "sparse signals" callout to add its five `planctl_*` columns. Our edit adds the eighth column to that enumeration. Read the post-fn-598 README state before drafting; merge cleanly.
- **Inspect section drift.** fn-598 may add `planctl_*` queries to Inspect. Our queries are independent — no merge conflict expected, but stylistic consistency matters.

### Test notes

No new automated tests; docs change only. Smoke check: read the revised README + CLAUDE.md top-to-bottom and verify the new column / collection / projection names are consistent everywhere they appear. Run `git diff README.md CLAUDE.md` and self-review for prose drift.

## Acceptance

- [ ] `README.md` "sparse signals" paragraph names `events.tool_use_id` alongside the existing sparse columns (and any fn-598 additions).
- [ ] `README.md` "Two collections register today" sentences (in both "What keeper is" and Architecture) revised to name `subagent_invocations` as the third collection.
- [ ] `README.md` Inspect section has at least two new queries: a representative `SELECT` against `subagent_invocations` and a `SELECT COUNT(*) FROM events WHERE tool_use_id IS NOT NULL`.
- [ ] `README.md` Architecture events-table description names `events.tool_use_id` in the existing sparse-columns sentence.
- [ ] `CLAUDE.md` "cursor + projection advance in same BEGIN IMMEDIATE" bullet's parenthetical lists `subagent_invocations` alongside `jobs`/`epics`.
- [ ] No new DO NOT entries; no new sections; edits are surgical, not narrative.

## Done summary
Doc edits per spec: README sparse-signals count 7->8 names events.tool_use_id; collection list 2->3 names subagent_invocations (both in 'What keeper is' and Architecture); Architecture events-table sentence cross-refs the eight sparse signals; Inspect section gains a per-job subagent_invocations timeline query and a tool_use_id count query. CLAUDE.md BEGIN IMMEDIATE bullet's projection parenthetical adds subagent_invocations.
## Evidence
