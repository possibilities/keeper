## Overview

Keeper's skills assume arthack CLIs are on PATH (hard-declared in allowed-tools and woven
through investigation recipes), which breaks the standalone story and any machine without the
arthack toolbelt. Make every arthack-CLI reference degrade gracefully — close-planner's "if
absent, move on" is the in-repo template — plus two small operator fixes: the autopilot
snapshot viewer's empty frame, and the stale hookctl phrasing. Runs parallel to the
dissolution epic (skill/template files are disjoint from its src/ surfaces).

## Quick commands

- On a PATH without arthack CLIs, /plan:hack and practice-scout runs complete with degraded (not failed) investigation
- `keeper autopilot` in non-TTY mode prints a non-empty snapshot frame

## Acceptance

- [ ] No keeper/plan skill or agent hard-requires an arthack CLI; each reference guards on presence with a stated fallback
- [ ] practice-scout's render-time shell teasers are null-safe when the CLI is absent
- [ ] Stale hookctl-tracker phrasing pruned; autopilot snapshot viewer emits a real frame
- [ ] Renders regenerated; render-consistency + skill lints green

## Early proof point

Task `.1` — grep-driven and mechanical; close-planner.md's existing guard proves the pattern.

## References

- Dissolution study §1.6 — the reference inventory (hack SKILL allowed-tools + recipes, practice-scout.tmpl:26-67 shell teasers, panel:74, plan:605, close-planner:215 the good example, work.md.tmpl:30 stale hookctl)
- Inventory item 12 — `keeper autopilot` snapshot produced an empty frame during live diagnosis while the sqlite route worked

## Docs gaps

- **docs/plugin-composition-map.md**: note that skills degrade rather than require the arthack toolbelt
