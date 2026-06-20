## Description

**Size:** S
**Files:** `README.md`, `CLAUDE.md`, `plugins/plan/CLAUDE.md`, `plugins/plan/skills/hack/SKILL.md`

### Approach

Forward-facing docs sweep after `.1`'s rename lands. The live sqlite forensics recipes query `planctl_op`/`planctl_epic_id`/`planctl_task_id` + `idx_events_planctl_*` and BREAK against the renamed schema — update them to `plan_*`. State the present; never write "formerly `planctl_*`".

### Investigation targets

**Required** (read before coding):
- `README.md` — `## Architecture` event-column prose, the sqlite forensics recipe block (queries `planctl_op/target/epic_id` + `idx_events_planctl_*`), the RETENTION_SHED_CLASS_PREDICATE description, and ~20 backward-facing changelog entries naming `planctl_*` (prune to present-tense per the forward-facing rule)
- `CLAUDE.md` — the "Event-sourcing invariants" inline example listing `planctl_op` among cheap columns
- `plugins/plan/CLAUDE.md` lines 81, 88 — session-history recipes querying `planctl_op/epic_id/task_id`
- `plugins/plan/skills/hack/SKILL.md` lines 81, 88 — the same recipes (baked from `promptctl render engineering/keeper-history-forensics`)

### Risks

- The `keeper-history-forensics` promptctl snippet is the canonical source for the baked `SKILL.md` recipes (and likely the `plugins/plan/CLAUDE.md` block). It may live OUTSIDE this repo — editing the baked files without updating the snippet means a re-bake reintroduces `planctl_*`. Flag this explicitly in the Done summary; coordinate the snippet update or note it as a follow-up.

### Test notes

- No code. Verify each updated sqlite recipe actually runs against the post-migration `plan_*` schema.

## Acceptance

- [ ] README forensics recipes + architecture prose use `plan_*`; backward-facing `planctl_*` changelog entries pruned to present-tense
- [ ] `CLAUDE.md`, `plugins/plan/CLAUDE.md`, `plugins/plan/skills/hack/SKILL.md` recipes use `plan_*`
- [ ] `keeper-history-forensics` promptctl snippet drift flagged (snippet updated or recorded as a follow-up)

## Done summary

## Evidence
