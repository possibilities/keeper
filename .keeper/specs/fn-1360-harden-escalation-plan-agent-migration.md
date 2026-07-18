## Overview

Close out two loose ends from rendering the four escalation capabilities as
confined plan:* agents. Two thin-wrapper skills carry behavior regressions
(a false stale_base decline and a dropped cold-dispatch page), and the
epic's two headline paths — the default_pin rendering fallback and the
grant-guard confinement of the new agent_types — ship with no end-to-end
test. This follow-up fixes the regressions and adds the missing coverage.

## Acceptance

- [ ] The repair skill captures the spawn-time tip after the ff-only pull, and the unblock skill pages once on a failed cold-dispatch
- [ ] The default_pin fallback (render + compile paths, including the effort-axis throw) is exercised end-to-end
- [ ] A spawned escalation subagent's in-tree write is proven grant-gated (denied without a matching grant leaf, allowed with one)

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .2 | default_pin fallback (planRoles/renderAgents fallback + effort-axis throw) is task 1's headline deliverable yet untested end-to-end; every fixture/example matrix carries explicit pins. |
| F2 | kept | .1 | repair SKILL.md captures HEAD before the ff-only pull while the payload wants the post-pull tip; repairer.md.tmpl returns stale_base on HEAD!=expected_tip, false-declining a healthy repair. |
| F3 | merged-into-F2 | .1 | F3 (unblock SKILL.md drops the failed-cold-dispatch page) merges into F2's task — both are behavior regressions in the rewritten thin-wrapper skills. |
| F4 | culled | — | repair Phase 4 ping hardcodes outcome:fixed; the collapsed fixed-vs-no-op distinction is a cosmetic loss on a non-actionable audit ping. |
| F5 | merged-into-F1 | .2 | F5 (confinement unverified: grant-guard keys on bare agent_type with no plan: prefix strip and no test covers a plan:-prefixed spawn) merges into F1's test-coverage task. |

## Out of scope

- The grant-guard hook and grant-leaf enforcement themselves (prior groundwork, fn-1347); this only adds an integration assertion over them.
- The audit ping's fixed-vs-no-op observability (F4, culled).
