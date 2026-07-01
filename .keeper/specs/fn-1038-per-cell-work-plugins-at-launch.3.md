## Description

**Size:** M
**Files:** plugins/plan/template/skills/work.md.tmpl, plugins/plan/hooks/hooks.json, plugins/plan/agents/worker-opus-*.md (remove), plugins/plan/.gitignore, plugins/plan/src/verbs/{claim,worker_resume,resolve_task}.ts, plugins/plan/src/models.ts, plugins/plan/test/{consistency-skills,consistency-generated-guard,saga-claim,saga-worker-resume,saga-validate-resolve}.test.ts

### Approach

Flip `work.md.tmpl` to spawn the CONSTANT `work:worker` (Phase 2a spawn + Phase 2b cold-spawn blocks), decoupling the spawn from the envelope's `worker_agent` VALUE while KEEPING its null-ness as the hard-stop gate (null either axis → stop). Retarget the `SubagentStop` matcher in `plugins/plan/hooks/hooks.json` from the `plan:worker-` prefix to `^work:worker$` (anchored — the colon puts it on the regex path). Delete the four generated `plugins/plan/agents/worker-opus-*.md` + `.managed-file-dont-edit` sidecars and flip `plugins/plan/.gitignore` from `agents/worker-*.md` to `workers/`. In claim/worker_resume/resolve_task, keep surfacing the `(model,effort)` cell (the launcher consumes it) and the null-gate; `workerAgentFor`'s composed name is now vestigial for the spawn. Add a guard/acceptance that no scanned/installed plugin named `work` shadows the cells (post arthack-rename).

### Investigation targets

**Required** (read before coding):
- plugins/plan/template/skills/work.md.tmpl:61,63,97,151,157 — spawn sites + the null-axis gate to preserve
- plugins/plan/hooks/hooks.json:40 — matcher
- plugins/plan/src/models.ts:152-171 (`workerAgentFor` null gate), claim.ts:359 / worker_resume.ts:176 / resolve_task.ts:133
- plugins/plan/test/consistency-skills.test.ts:412-414 (asserts NOT work:worker/plugin-dir, DOES contain plan:worker-<model>-<effort> — all invert), consistency-generated-guard.test.ts:103 (matcher)

### Risks

- Atomicity: land the skill spawn + matcher + agent deletion together so no window emits `work:worker` with the old agents still resolving, or vice-versa.
- Don't drop the null-either-axis stop when decoupling the spawn from the name value.

### Test notes

Invert consistency-skills (:412-414) and consistency-generated-guard (:103); update saga-claim/worker-resume/validate-resolve name assertions. Confirm the guard fires when a stray `work` plugin is scanned.

## Acceptance

- [ ] `/plan:work` spawns the constant `work:worker` in both spawn paths; the null-either-axis stop is preserved.
- [ ] `SubagentStop` matcher is `^work:worker$` and fires for the launched cell.
- [ ] The four old `plan:worker-*` agents + sidecars are deleted; `.gitignore` tracks `workers/`.
- [ ] Consistency tests invert; a scanned/installed `work`-name collision is caught by a guard.

## Done summary

## Evidence
