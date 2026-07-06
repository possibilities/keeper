## Description

**Size:** M
**Files:** cli/handoff.ts, cli/show-job.ts, src/agent/dispatch.ts, plugins/keeper/skills/handoff/SKILL.md, plugins/plan/agents/panel-runner.md, docs/problem-codes.md, test/dispatch-cli.test.ts, test/agent-panel-cli.test.ts

### Approach

Disambiguate the directory and session flag families, hard cutover. `keeper handoff --dir` → `--cwd` (it is the worker launch directory; dispatch already spells it `--cwd`). `keeper agent panel --dir` → `--run-dir` on start/wait/status (it addresses the durable slug-keyed run directory, not a launch cwd — renaming it `--cwd` would repurpose semantics). `keeper show-job`: drop the `--session-id` selector binding entirely (it matched job_id; `--job-id` is the honest spelling and stays), and rename `--session` → `--session-title`; `--session` is now reserved repo-wide for the tmux sense (handoff/dispatch/tabs/setup-tmux/agent keep theirs unchanged). The pi harness's outbound `--session` resume token is a partner CLI's flag — untouched. Retired spellings hard-fail at exit 2. Migrate every in-repo citation: handoff SKILL.md (frontmatter argument-hint, flag table, prose, exit-code table), panel-runner.md wait/status invocations, problem-codes.md show-job selector rows and recovery strings, and show-job's selectorKind labels. Update the affected descriptors.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/handoff.ts:65,86,102-143,352 — --dir definition + resolveLaunchDir
- src/agent/dispatch.ts:88-90,234-236,251 — panel --dir sites (run-dir semantics; --dir wins over --slug in wait/status — preserve that rule under the new name)
- cli/show-job.ts:60-61,399,536 — the --session-id→jobId binding to drop, --session→title to rename, selectorKind labels
- docs/problem-codes.md:39-40 — selector rows to update

**Optional** (reference as needed):
- src/agent/harness.ts:136,196 — the outbound pi --session token that must NOT change
- plugins/keeper/skills/dispatch/SKILL.md:77 — tmux --session sense that must NOT change

### Risks

- The plan:panel-runner agent is live tooling — its --run-dir migration must land in the same commit as the flag rename or panels break mid-epic.

### Test notes

Existing dispatch/panel suites update invocations; add retired-spelling-fails cases for --dir (handoff, panel), --session-id and --session (show-job).

## Acceptance

- [ ] `keeper handoff --cwd`, `keeper agent panel --run-dir`, `keeper show-job --job-id`/`--session-title` are the only spellings; retired spellings exit 2
- [ ] `--session` means the tmux session everywhere it survives, and no keeper-owned flag spells a Claude session selector as `--session` or `--session-id`
- [ ] Every in-repo skill, agent doc, and docs/ citation uses the new spellings

## Done summary
Disambiguated the dir/session flag families with hard cutover: handoff --dir→--cwd, agent panel --dir→--run-dir, show-job dropped --session-id (matched job_id) and renamed --session→--session-title (--job-id stays honest). Retired spellings hard-fail exit 2 before any daemon touch via parseHandoffArgs/parsePanelArgs guards. --session now means the tmux session everywhere it survives; migrated every in-repo citation (skills, panel-runner agent, problem-codes, vendored corpus+lock, source comments) and the native descriptors. Pre-existing prompt-suite render-golden drift (upstream ~/code/arthack ahead of render.json) is out of scope for this flag-grammar task.
## Evidence
