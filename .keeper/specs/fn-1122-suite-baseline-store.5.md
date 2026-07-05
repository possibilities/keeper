## Description

**Size:** S
**Files:** plugins/plan/template/agents/worker.md.tmpl, plugins/plan/template/skills/work.md.tmpl, plugins/plan/skills/work/SKILL.md, plugins/plan/workers/opus-medium/agents/worker.md, plugins/plan/workers/opus-high/agents/worker.md, plugins/plan/workers/opus-xhigh/agents/worker.md, plugins/plan/workers/opus-max/agents/worker.md, plugins/prompt/test/oracle/fixtures/render-plugin-templates.json, README.md, CLAUDE.md, plugins/plan/CLAUDE.md

### Approach

Point every failure-triage surface at the baseline verb, editing templates
only and regenerating. In the worker-agent template: the stash-ban
paragraph gains "to check whether a failure is pre-existing at your base
commit, use `keeper baseline <task-start sha> --wait`", and the
failure-triage ladder (the DEPENDENCY_BLOCKED and TOOLING_FAILURE
anchors) routes a worker through the baseline verb before classifying an
out-of-scope failure — including the env-fidelity caveat: the baseline
answers "red at this sha in a healthy environment"; a red only in your
worktree points at your environment, not the base. Same pointer in the
work-skill template's Shared-tree paragraph. Regenerate the skill + four
worker manifests, recapture the prompt oracle fixture. README gains
`keeper baseline` in the one-binary verb list. CLAUDE.md gains one
sole-writer guardrail line (CLI sole writer of the baseline spool,
baseline worker sole writer of leafs) folded into the existing sole-writer
rules — re-measure the size budget and prune elsewhere only if required.
Optional consistency: one sanctioned-alternative pointer in
plugins/plan/CLAUDE.md next to its stash-deny mention. All prose is
present-tense and uses the glossary term Baseline — never cache, snapshot,
or sidecar.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/template/agents/worker.md.tmpl:85 — the stash-ban paragraph; :93 and :147 — the DEPENDENCY_BLOCKED and TOOLING_FAILURE triage anchors to route through the verb
- plugins/plan/template/skills/work.md.tmpl:30 — the Shared-tree paragraph
- plugins/plan/scripts/promote.sh:67 — the regeneration invocation (bun cli/prompt.ts render-plugin-templates --project-root <root>)
- plugins/prompt/test/oracle/capture.ts — fixture recapture (needs the arthack corpus; present on this host)
- scripts/lint-claude-md.ts — the CLAUDE.md size gate to re-measure before committing

**Optional** (reference as needed):
- plugins/plan/plugin/hooks/pre-hook.ts — generated files are Write/Edit-denied; regenerate, never hand-edit
- README.md:150 — the one-binary verb list
- CONTEXT.md — Baseline term wording to echo

### Risks

- CLAUDE.md byte budget is tight; the sole-writer line must fold into existing prose, with a compensating prune only if the gate demands it.
- The oracle fixture embeds full rendered bodies — the prompt parity suite stays red until recapture runs.

### Test notes

bun scripts/lint-claude-md.ts green; keeper prompt check-generated clean
after regeneration; the prompt plugin oracle parity suite green after
recapture; root fast suite green.

## Acceptance

- [ ] The rendered work skill and all four worker manifests tell a worker to consult `keeper baseline` (with the task-start-sha contract and the env-fidelity caveat) before classifying an out-of-scope test failure, produced by regeneration with check-generated clean
- [ ] README lists the baseline verb; CLAUDE.md carries the spool/leaf sole-writer line and its lint gate is green
- [ ] The prompt oracle parity suite is green with the recaptured fixture
- [ ] No touched prose says cache, snapshot, or sidecar for the baseline surfaces, and no history narration appears
## Done summary

## Evidence
