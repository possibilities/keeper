## Description

**Size:** M
**Files:** plugins/plan/template/agents/worker.md.tmpl, plugins/plan/src/subagents_config.ts, plugins/plan/workers/** (generated), plugins/prompt/test/oracle/capture.ts, plugins/prompt/test/oracle/fixtures/{render-plugin-templates,check-generated}.json

### Approach

Change `worker.md.tmpl` frontmatter to `name: worker` (constant) + `render_to: workers/{{ current_model }}-{{ current_effort }}` + a `manifest_description:` (required by `resolveAgentOutput`, else every cell render throws). The existing 2D matrix branch binds `current_model`/`current_effort` per cell, and `render_to` resolves POST-render from each cell's frontmatter, so this fans out one `plugins/plan/workers/<model>-<effort>/{.claude-plugin/plugin.json (name=work), agents/worker.md}` per cell (manifest `name` is already hardcoded `work`). Keep the four existing `plan:worker-*` agents in place THIS task (green — both schemes coexist). Add a shared `<workers-base>/<model>-<effort>` cell-path helper to `subagents_config.ts` (one source for renderer + launcher). Extend the oracle `collectRenderedTree` (capture.ts:229-255) to also walk `workers/`, then regenerate both fixtures. **Prove** (the early-proof deliverable): a manual `keeper agent claude --plugin-dir plugins/plan/workers/opus-high '/plan:work …'`-shaped session resolves `work:worker`; loading `--plugin-dir plugins/plan` does NOT recursively load the nested `workers/*/` manifests (verify empirically — if it does, relocate the workers base to a render_to-reachable path that isn't a nested plugin, and record the finding); and the arthack `work` name is freed (no scanned `work` plugin shadows the cell).

### Investigation targets

**Required** (read before coding):
- plugins/prompt/src/render_plugin_templates.ts:446-499 (`resolveAgentOutput`/render_to, traversal guard, manifest_description throw), :160-168 (`manifestContent` name="work"), :561-582 (matrix branch)
- plugins/plan/template/agents/worker.md.tmpl — current frontmatter to rebind
- plugins/plan/src/subagents_config.ts — `SubagentsMatrix`; add the cell-path helper here
- plugins/prompt/test/oracle/capture.ts:229-255 (`collectRenderedTree` walks only commands/skills/agents — the CRITICAL gap)

### Risks

- Nested-plugin auto-load would void the single-load guarantee (early-proof gate; relocation fallback).
- `manifest_description:` missing → every cell render throws; add it with the render_to line, not after.
- Oracle silently omits the new `workers/` tree unless `collectRenderedTree` is extended.

### Test notes

Regenerate oracle fixtures (`bun run capture-oracle` from plugins/prompt). Assert each cell dir has a `plugin.json` (name=work) + `agents/worker.md` (name=worker, correct model/effort). Existing worker-name tests stay green (old agents still present this task).

## Acceptance

- [ ] Each matrix cell renders `plugins/plan/workers/<model>-<effort>/{.claude-plugin/plugin.json, agents/worker.md}`; manifest name `work`, agent name `worker`.
- [ ] A single `--plugin-dir`'d cell resolves `work:worker`; nested-plugin auto-load is empirically ruled out (or the base relocated) and recorded.
- [ ] The shared cell-path helper lives in `subagents_config.ts`; oracle `collectRenderedTree` walks `workers/` and fixtures are regenerated.
- [ ] The old `plan:worker-*` agents remain and the tree is green (coexistence).

## Done summary
Rendered per-cell work plugins (name=work, agent=worker) into plugins/plan/workers/<model>-<effort>/ via render_to, added the shared workerCellDir helper, extended the oracle+parity tree walks to workers/, and regenerated fixtures — old plan:worker-* agents coexist and the tree is green. Proof: single-load holds (--plugin-dir loads only the target dir's root manifest; workers manifests are depth-2 and never auto-loaded, so no base relocation needed), but the arthack 'work' plugin (~/code/arthack/claude/work) still claims name 'work' in a plugin_scan_dir, so the task-3 cutover is gated on the pending rename-work-skills-to-arthack handoff.
## Evidence
