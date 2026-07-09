## Description

Finding F1 (Axis 1 Should-fix), with merged F3 (test gap). Evidence path:
`plugins/plan/src/verbs/apply_selection.ts:103` calls `resolveProject(null)`
(cwd git-root) and `ApplySelectionArgs` (lines 62-69) carries no project field;
`plugins/plan/src/descriptor.ts:344` exposes no `--project` option and
`plugins/plan/src/cli.ts:773` threads none. Sibling verbs
`plugins/plan/src/verbs/selection_brief.ts` (via `resolvePlanStateContext`) and
`plugins/plan/src/verbs/close_preflight.ts:268-311` both take `--project` and
re-root plan state through `contextForRoot(primary_repo)`; the close skill
`plugins/plan/skills/close/SKILL.md:187` omits `--project` on apply-selection
while passing it to every sibling call. Fix: add a `--project` option to the
apply-selection descriptor + cli, thread it into `runApplySelection`, and resolve
the state context through the epic's `primary_repo` (matching close_preflight's
`contextForRoot(primaryRepo)` re-root), then pass `--project <primary_repo>` from
the `/plan:close` 3.5c beat. F3: cover a brief-in-primary / apply-from-lane
(cwd != primary_repo) case in the plan test suite, asserting researched cells land.

Files: `plugins/plan/src/verbs/apply_selection.ts`,
`plugins/plan/src/descriptor.ts`, `plugins/plan/src/cli.ts`,
`plugins/plan/skills/close/SKILL.md`, plus a plan test.

## Acceptance

- [ ] `apply-selection` accepts `--project <abs_path>` (absolute-only, matching close_preflight's guard) and re-roots plan-state reads/writes through the epic's primary_repo.
- [ ] The `/plan:close` 3.5c beat passes `--project <primary_repo>` to apply-selection.
- [ ] A cross-cwd (brief-in-primary / apply-from-lane) close test asserts the researched cells land rather than degrading to defaults.
- [ ] `bun test` (plan fast suite) is green.

## Done summary
Added --project to apply-selection, re-rooted plan-state through the epic's primary_repo (matching close_preflight/close_finalize), threaded --project <primary_repo> through the /plan:close 3.5c beat, and covered a brief-in-primary / apply-from-lane close with a cross-cwd test.
## Evidence
