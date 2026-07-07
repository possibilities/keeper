## Description

**Size:** S
**Files:** CLAUDE.md, plugins/plan/CLAUDE.md, CONTEXT.md, docs/plugin-composition-map.md

### Approach

Fold the shipped posture into the imperative docs, prune-first per rule zero. Root
CLAUDE.md: the hooks bullet's count and inventory gain the escalation guard (five ->
six) with its one behavioral surprise (role-marked sessions fail closed via envelope,
still exit 0); the Autopilot escalation narrative folds the category-routed repair path
(SHARED_BASE_BROKEN -> one repair per repo+fingerprint, positive-evidence clear,
page-once decline, retry re-arm) INTO the existing block/merge-escalation prose —
revise and prune in place, never bolt on; KEEPER_ESCALATION_ROLE is documented in the
hook rules (it is a keeper-injected, keeper-hook-read marker — not a KEEPER_PLAN_* env
var, so the plan plugin's env table does NOT gain it). plugins/plan/CLAUDE.md: the
skills inventory names /plan:repair alongside unblock/deconflict. CONTEXT.md: three
glossary entries in the existing escalation-family style — Repair session (repo-scoped
write-capable escalation; trunk-committing; disambiguate from Deconflict = merge
conflict, epic-scoped), SHARED_BASE_BROKEN (baseline-gated category: base red in a
healthy env independent of the worker's diff), Escalation role (the launch-injected
posture marker the guard keys on) — with Avoid lines. docs/plugin-composition-map.md:
the escalation-dispatches section gains the repair verb and the sixth hook. Keep the
CLAUDE.md size/lint gate green.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- CLAUDE.md — the hooks bullet and the Autopilot escalation paragraph as they exist AFTER the code tasks land (they move; read fresh)
- scripts/lint-claude-md.ts — the size + re-narration gate the root edit must satisfy
- CONTEXT.md — the Unblock session / Deconflict session / Resolver entries whose style the three new entries match

**Optional** (reference as needed):
- docs/plugin-composition-map.md — escalation-dispatches section
- docs/adr/0017-trunk-repair-escalation-and-role-keyed-guard.md — the landed decision record these docs summarize, never re-narrate

### Risks

- The Autopilot paragraph is dense and contested by an in-flight epic's edits — rebase-read it immediately before editing
- Rule zero: no incident history, no fn-ids, no "formerly" — forward-facing behavior only

### Test notes

bun scripts/lint-claude-md.ts green; a grep for backward-facing markers (formerly,
renamed from, fn-) over the touched docs comes back clean.

## Acceptance

- [ ] Root CLAUDE.md documents six hooks including the escalation guard's role-keyed fail-closed envelope behavior, and its Autopilot narrative describes the category-routed repair path as revised-in-place prose
- [ ] The plan plugin CLAUDE.md skills inventory includes the repair skill
- [ ] CONTEXT.md defines Repair session, SHARED_BASE_BROKEN, and Escalation role in the existing glossary style with Avoid lines
- [ ] The plugin composition map's escalation section names the repair verb and the sixth hook
- [ ] The CLAUDE.md lint gate passes and no touched doc carries backward-facing narration

## Done summary

## Evidence
