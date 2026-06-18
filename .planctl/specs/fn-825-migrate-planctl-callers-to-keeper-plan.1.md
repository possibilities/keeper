## Description

**Size:** M
**Files:** plugins/plan/template/**, plugins/plan/skills/** + agents/** (regenerated), the `.managed-file-dont-edit` outputs

### Approach

In `plugins/plan/template/**`, replace `planctl <verb>` command invocations with `keeper plan <verb>` and `allowed-tools: Bash(planctl:*)` with `Bash(keeper plan:*)`. Re-render with `promptctl render-plugin-templates --project-root ~/code/keeper/plugins/plan` so the worker/scout agents + skills regenerate. VERIFY the `Bash(keeper plan:*)` permission actually grants `keeper plan claim …` in a real worker (spawn one); if Claude Code's prefix match needs a single token, use `Bash(keeper:*)` and note it. Do NOT touch internal envelope/source names (that is epic 3) or `.planctl` data paths (epic 4) — only the COMMAND callers here.

### Investigation targets

**Required**:
- plugins/plan/template/skills/work.md.tmpl + the worker.md.tmpl variants — the `Bash(planctl:*)` + `planctl` callers
- plugins/plan/skills/{plan,close,defer,next,work,hack}/SKILL.md — `allowed-tools` + body callers
- arthack install.sh — confirm `render-plugin-templates --project-root ~/code/keeper/plugins/plan` is the render entry

### Risks

- `Bash(keeper plan:*)` two-word prefix may not match Claude Code's permission grammar — verify with a real spawn; fall back to `Bash(keeper:*)`.
- Re-render must regenerate ALL `.managed-file-dont-edit` outputs; stale outputs that still say `planctl` would slip through — diff the render.

### Test notes

After render, `rg -n '\bplanctl ' plugins/plan/{skills,agents,template}` returns only non-command mentions (if any). Spawn a worker via `/plan:work` against a scratch task to confirm `keeper plan claim/done` works under the new allowed-tools.

## Acceptance

- [ ] templates use `keeper plan <verb>` + `Bash(keeper plan:*)` (or `Bash(keeper:*)` with a noted reason)
- [ ] re-render regenerates skills/agents; no rendered output invokes `planctl <verb>`
- [ ] a real worker spawn claims+dones a task under the new permissions

## Done summary
Repointed all planctl command callers to keeper plan across plan-plugin templates + hand-authored skills/agents, flipped allowed-tools to Bash(keeper plan:*), and re-rendered managed outputs. Zero command callers remain; keeper plan claim/done verified routing.
## Evidence
