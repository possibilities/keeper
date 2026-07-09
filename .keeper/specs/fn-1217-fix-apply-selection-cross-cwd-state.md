## Overview

The `apply-selection` verb resolves its plan-state context from the cwd git-root
(`resolveProject(null)`) and exposes no `--project` option, unlike every sibling
close verb. In a worktree-mode close whose cwd is a lane (cwd != primary_repo),
`selection-brief --project <primary>` writes the brief under primary's gitignored
`state/` while `apply-selection` reads the lane's stale/empty `state/` — it finds
no brief, degrades silently, and the follow-up tasks are born with the mechanical
default cells instead of the researched selector cells. This defeats the entire
fn-1214 pre-select beat under worktree mode. This work adds `--project` and re-roots
state through the epic's `primary_repo`, matching the sibling verbs.

## Acceptance

- [ ] `apply-selection` accepts `--project <abs_path>` and re-roots plan-state
      reads/writes through the epic's `primary_repo`, so a cross-cwd invocation
      finds the brief and stages the verdict under primary's `state/`.
- [ ] The `/plan:close` 3.5c beat passes `--project <primary_repo>` to
      `apply-selection`, matching selection-brief / selection-audit-brief / close-finalize.
- [ ] A brief-in-primary / apply-from-lane (cwd != primary_repo) close is covered
      by a test that asserts the researched cells land rather than degrading.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | apply_selection.ts:103 resolveProject(null) + no --project (descriptor.ts:344, cli.ts:773) while siblings re-root via contextForRoot(primary_repo) (close_preflight.ts:304-311) and close SKILL.md:187 omits --project — worktree cross-cwd close silently degrades follow-up cells. |
| F2 | culled | — | Consider-tier duplicated-code (parseVerdictShape vs assign-cells); auditor calls the JSON-vs-YAML split defensible and advises leave-as-is. |
| F3 | merged-into-F1 | .1 | F3 (cross-cwd close untested) is the test proving F1's fix — folded into F1's task acceptance, not a separate cluster. |
| F4 | culled | — | --degraded empty-cell edge is unreachable: scaffold always stamps default tier/model, so stored cells are never empty. |

## Out of scope

- Hoisting per-cell field validation into `selection_apply_core.ts` (F2) — deferred; the JSON-vs-YAML split is defensible until a third cell-shaped input appears.
- The `--degraded` empty-cell axis check (F4) — the precondition is unreachable while scaffold stamps defaults.
