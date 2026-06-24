## Overview

The pair SKILL.md documents that a claude preset's `effort` is dropped, but
the launcher actually honors it. This is a single docs-accuracy fix: correct
the one inaccurate parenthetical so an operator can trust what their claude
preset's `effort` field does on a `keeper pair --preset` launch.

## Acceptance

- [ ] SKILL.md no longer asserts a claude preset's effort is dropped; it states the effort is honored via the launcher
- [ ] The (correct) explicit `--effort --cli claude` arg-fault claims are left intact

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | SKILL.md:118 claims a claude preset's effort is dropped, but src/agent/main.ts:1314-1330 pushes --effort from the preset on the pair launch path. |
| F2 | culled | — | Preset/panel same-name collision is a low-impact defensive footgun; remedy is only a guard, no user-facing defect. |
| F3 | culled | — | autopilot-worker.ts:1431-1433 spread is a pure style nitpick, behaviorally equivalent. |
| F4 | culled | — | cli/pair.ts:266 --role default sentinel edge is degenerate; auditor says fine to ship. |
| F5 | culled | — | Test for the preset/panel collision is conditional on F2's culled guard. |
| F6 | culled | — | presetsConfigPath() env override is already exercised indirectly; missing direct unit assertion is Minor. |

## Out of scope

- The preset/panel name-collision load guard (F2) and its test (F5) — deferred, low impact.
- The autopilot-worker spread cleanup (F3) and the pair `--role default` sentinel edge (F4).
- A direct unit test for `presetsConfigPath()` (F6) — covered indirectly.
