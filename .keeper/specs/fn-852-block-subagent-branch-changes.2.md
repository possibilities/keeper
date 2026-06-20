## Description

**Size:** S
**Files:** plugins/plan/template/agents/worker.md.tmpl, plugins/plan/agents/worker-{medium,high,xhigh,max}.md (regenerated), plugins/plan/src/verbs/gist.ts, plugins/plan/test/verbs-gist.test.ts

### Approach

Remove the two soft pressures that led a worker to improvise a branch. (1) Add an explicit guardrail to the worker prompt TEMPLATE `plugins/plan/template/agents/worker.md.tmpl` — the rendered `worker-*.md` are generated/managed (`.managed-file-dont-edit` sidecar), NEVER hand-edit them. Imperative, bold-lead, forward-facing wording matching the file's existing constraint style, e.g. "**Never create or switch branches.** Work in place on the branch that was current when you launched; never run `git checkout -b` / `switch -c` / `branch <name>` / `worktree add`, and never switch branches. Branch management is out of scope — the keeper branch-guard hook hard-blocks it." Place it in the Phase 1 / orientation area near the existing session-state/branch read. Then regenerate all four `worker-*.md` via `promptctl render-plugin-templates --project-root /Users/mike/code/keeper` and commit the regenerated sidecars. (2) Drop the misleading `- **Branch:** \`${branch}\`` line from `buildToc` in `plugins/plan/src/verbs/gist.ts` (~:206-208, the `if (branch)` push block) so the worker brief stops implying per-epic branch ownership. Update `plugins/plan/test/verbs-gist.test.ts` fixtures/assertions that snapshot the TOC to drop the Branch line.

### Investigation targets

**Required** (read before coding):
- plugins/plan/template/agents/worker.md.tmpl — the real edit target (NOT the rendered worker-*.md); find the orientation/Phase 1 section and the existing constraint style. Verify this path exists before editing.
- plugins/plan/src/verbs/gist.ts:202,206-208 — the buildToc Branch line to remove.
- plugins/plan/test/verbs-gist.test.ts — fixtures/assertions to update.

**Optional** (reference as needed):
- plugins/plan/src/models.ts:17-19 — branch_name default "main" (leave as-is; removing the gist line is the chosen lever, not changing the default).
- plugins/plan/skills/work/SKILL.md:6 — the orchestrator-side "current branch only — no worktree" rule, for wording consistency.

### Risks

- worker-*.md are managed/generated — edits to them are lost on re-render; edit the .tmpl and re-render. Confirm the render command and that all four tiers regenerate with the guardrail.
- These edits land INSIDE the plugins/plan git subtree — do not restructure; a normal direct commit to main is fine. Never squash-merge a subtree change (general repo rule).
- Verify the .tmpl path before editing — a stale path silently edits nothing.

### Test notes

Update plugins/plan/test/verbs-gist.test.ts to expect no Branch line. Run the plan suite incl. slow tier: `(cd plugins/plan && PLANCTL_RUN_SLOW=1 bun test)`. Confirm the rendered worker-*.md contain the new guardrail after re-render (grep or manual check).

## Acceptance

- [ ] plugins/plan/template/agents/worker.md.tmpl carries an explicit "never create or switch branches; work in place" guardrail (forward-facing, imperative).
- [ ] All four plugins/plan/agents/worker-{medium,high,xhigh,max}.md are regenerated from the template and contain the guardrail.
- [ ] The `- **Branch:**` line is removed from gist.ts buildToc; the worker brief no longer emits it.
- [ ] plugins/plan/test/verbs-gist.test.ts updated and green; plan slow-tier tests pass.

## Done summary
Added a 'never create or switch branches; work in place' guardrail to worker.md.tmpl (regenerated all four worker-*.md), removed the misleading Branch line from gist buildToc, and added a TOC test asserting its absence.
## Evidence
