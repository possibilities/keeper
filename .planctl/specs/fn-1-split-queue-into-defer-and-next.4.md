## Description

**Size:** M
**Files:** skills/plan/SKILL.md, README.md, AGENTS.md, CLAUDE.md, docs/reference/commit-at-mutation-boundary.md

Update every prose reference to the new defer+next model. Present-tense
only — no tombstones, no "formerly /plan:queue" phrasing (CLAUDE.md
"Doc & comment style").

### Approach

- `skills/plan/SKILL.md` (~lines 345-357, Phase 4 undersized gate):
  collapse the four-phrase commit/queue/defer/continue menu to
  commit/defer/continue. The defer handoff stays `/plan:defer`. Remove the
  "queue sketch" branch and the `/plan:queue` reference. Add one line that
  after deferring, `/plan:next <epic_id>` jumps the board. Update the
  explainer paragraph + question (lines 345-347) to drop the "queue it /
  queue for next" option in favor of "defer, then /plan:next to jump".
- `README.md` (~lines 154-156): drop the `/plan:queue` row; rewrite the
  `/plan:defer` row as the sole single-task scaffolder; add a `/plan:next`
  row and note the `planctl epic queue-jump` verb.
- `AGENTS.md` (~line 54): rewrite the fn-595 sibling-scaffolder paragraph
  — defer is now a hand-written source skill (not template-generated),
  `/plan:next` flips `queue_jump` post-hoc on an existing epic via
  `epic queue-jump`.
- `CLAUDE.md`: rewrite the `/plan:queue` fn-595 paragraph to describe
  `/plan:next` → `epic queue-jump`; in the "Skills and agents" /
  generated-resources sections, list `defer` and `next` as hand-written
  (only `work` and the worker plugins remain template-generated).
- `docs/reference/commit-at-mutation-boundary.md` (~lines 102-110): note
  that `queue-jump` is the second verb (besides `scaffold`) that can carry
  `queue_jump:true` on its envelope.

### Investigation targets

**Required** (read before coding):
- skills/plan/SKILL.md lines 343-358 — the menu + four-trigger-phrases section to collapse.
- README.md lines 154-156 — the skill table rows.
- AGENTS.md line 54 — the fn-595 paragraph.
- CLAUDE.md — search `/plan:queue`, `queue_jump`, and the "Skills and agents" generated-skills list.
- docs/reference/commit-at-mutation-boundary.md lines 97-110 — the `queue_jump` envelope-field notes.

## Acceptance

- [ ] `/plan:plan` menu offers commit/defer/continue (no queue branch); names `/plan:next` as the post-defer priority lever.
- [ ] README, AGENTS.md, CLAUDE.md, commit-at-mutation-boundary.md describe defer (hand-written, sole scaffolder) + `/plan:next` + `epic queue-jump`, present-tense.
- [ ] No remaining `/plan:queue` reference in repo prose (except sanctioned history surfaces, of which there are none here).
- [ ] No tombstone phrasing introduced.

## Done summary

## Evidence
