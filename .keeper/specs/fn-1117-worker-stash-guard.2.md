## Description

**Size:** S
**Files:** plugins/plan/template/skills/work.md.tmpl, plugins/plan/template/agents/worker.md.tmpl, plugins/plan/skills/work/SKILL.md, plugins/plan/workers/opus-medium/agents/worker.md, plugins/plan/workers/opus-high/agents/worker.md, plugins/plan/workers/opus-xhigh/agents/worker.md, plugins/plan/workers/opus-max/agents/worker.md, plugins/prompt/test/oracle/fixtures/render-plugin-templates.json, CLAUDE.md, plugins/plan/CLAUDE.md, plugins/keeper/hooks/hooks.json

### Approach

Make every guard-narrating prose surface state the worker stash ban, editing
ONLY the template layer and regenerating derived files. Broaden the
Shared-tree principle in the work-skill template from "never auto-stash
someone else's files" to an outright worker stash ban: refs/stash is one
repo-global stack shared by every sibling worktree and the human's checkout,
so a worker never runs mutating `git stash` (the branch-guard hook
hard-denies it; list/show/create stay available); for file-level undo use
`git restore <path>`, to park work use a temp commit. Add stash to the
worker-agent template's mechanical-block sentence (the "never create or
switch branches" paragraph). Regenerate the generated skill + four worker
manifests via the render CLI, recapture the prompt oracle fixture, and fold
one clause into the existing CLAUDE.md branch-guard bullet (Hook rules).
Extend the two consistency surfaces (plan-plugin CLAUDE.md guard sentence,
keeper hooks.json description). All prose is forward-facing present tense —
state the rule as it is now, never what changed.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/template/skills/work.md.tmpl:30 — the Shared-tree principle line to broaden
- plugins/plan/template/agents/worker.md.tmpl:84 — the mechanical-block sentence (branch-guard reference) to extend
- plugins/plan/scripts/promote.sh:67 — the actual regeneration invocation shape (`bun cli/prompt.ts render-plugin-templates --project-root <keeper-root>`)
- plugins/prompt/test/oracle/capture.ts — fixture recapture entrypoint; resolves the arthack corpus via $ARTHACK_ROOT with the ~/code/arthack fallback (present on this host)
- CLAUDE.md:44 — the branch-guard Hook-rules bullet; fold a clause in place, do not add a bullet
- scripts/lint-claude-md.ts — the size/re-narration gate (hard caps 120 lines / 16384 bytes)

**Optional** (reference as needed):
- plugins/plan/plugin/hooks/pre-hook.ts — hard-denies Write/Edit on generated files; regeneration via the CLI is the only path
- plugins/plan/test/consistency-generated-guard.test.ts — pins template↔generated wiring
- plugins/plan/CLAUDE.md — the "hard-denies a worker subagent from git branch create/switch" sentence; add stash
- plugins/keeper/hooks/hooks.json:2 — the hook description field; add stash

### Risks

- CLAUDE.md byte budget: ~351 bytes of headroom pre-dep; the upstream fn-1106.7 whole-file prune lands first and reshapes the file — re-measure with lint-claude-md before committing and prune elsewhere only if the budget demands it.
- Never hand-edit the generated files (a PreToolUse hook denies the Write/Edit); a hand-edit attempt blocks the worker mid-task.
- The oracle fixture embeds full rendered bodies (content_b64) — the prompt parity suite stays red until recapture runs.

### Test notes

`bun scripts/lint-claude-md.ts`; `keeper prompt check-generated` clean after
regeneration; the prompt plugin oracle parity suite green after recapture;
root fast suite green.

## Acceptance

- [ ] The work-skill guidance and all four generated worker manifests state the worker stash ban with the shared-stack rationale and the restore/temp-commit alternatives, produced by regeneration (generated files match render output; check-generated clean)
- [ ] CLAUDE.md's Hook-rules branch-guard clause names the mutating-stash denial with the list/show/create allowlist, and the CLAUDE.md lint gate is green
- [ ] The prompt oracle parity suite is green with the recaptured fixture
- [ ] The plan-plugin CLAUDE.md guard sentence and the keeper hooks.json description mention the stash denial
- [ ] No touched prose narrates history — present-tense rule statements only

## Done summary

## Evidence
