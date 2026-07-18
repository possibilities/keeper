## Description

Two behavior regressions from the thin-wrapper rewrite (finding F2 and
F3), both in plugins/plan/skills/:

- F2 (repair/SKILL.md, Phase 2 to Phase 3): the skeleton lists
  `git rev-parse HEAD` before `git pull --ff-only`, but the Phase 3
  payload sets `expected_tip: "<current HEAD>"`. repairer.md.tmpl step 1
  returns `stale_base` when HEAD != expected_tip, so capturing the
  pre-pull tip false-declines a healthy repair whenever the shared
  checkout was behind. Fix: capture HEAD explicitly after the ff-only pull.
- F3 (unblock/SKILL.md, Phase 3): the rewrite dropped the old skill's
  "confirm the dispatch envelope reports success; a failed dispatch is a
  decline" step, so a failed `keeper dispatch work::<task_id>` now
  silently ends. Fix: restore the "a failed cold-dispatch pages once and
  declines" instruction to Phase 3.

Files: plugins/plan/skills/repair/SKILL.md, plugins/plan/skills/unblock/SKILL.md

## Acceptance

- [ ] repair/SKILL.md captures the spawn-time HEAD after `git pull --ff-only`, so expected_tip matches the tip the repairer will observe
- [ ] unblock/SKILL.md Phase 3 pages once and declines on a failed cold-dispatch rather than silently ending

## Done summary

## Evidence
