## Description

**Size:** M
**Files:** template/agents/worker.md.tmpl, template/skills/work.md.tmpl, .gitignore, tests/test_work_skill_consistency.py

### Approach

Three coupled moves, all in the planctl `plan` plugin.

(1) **Worker template → `agents/`.** In `template/agents/worker.md.tmpl`,
delete the `render_to:` and `manifest_description:` frontmatter, keep
`variants: [medium, high, xhigh, max]`, and set `name: worker-{{ current_variant }}`.
promptctl's default (non-`render_to`) agents branch then emits
`agents/worker-<tier>.md` per variant (filename = template stem + variant),
each addressable `plan:worker-<tier>`, gitignored + sidecar-guarded exactly
like `agents/practice-scout.md`. Keep `model: opus` + `effort: {{ current_variant }}`.
Narrow the agent `description` to internal-only (e.g. "Internal task-execution
worker — spawned programmatically by /plan:work, never invoked from user
requests") so four in-scope tiers never auto-delegate.

(2) **Skill pass-through.** In `template/skills/work.md.tmpl`, both spawn
sites become `Task(subagent_type=<worker_agent from the envelope>)` — the
warm spawn reads `worker_agent` from the `claim` envelope (Phase 2a), the
cold-resume spawn reads it from the `worker resume` envelope (Phase 2b). No
tier→agent mapping in the skill, no bare `work:worker`. If `worker_agent` is
null (legacy null-tier task), surface a typed stop ("tier unset — remediate
via /plan:plan <epic_id> refine") instead of spawning. Rewrite the stale
tier/plugin-dir prose at the listed lines to the present-tense reality (keeper
launches with no `--plugin-dir`; the skill spawns the emitted `worker_agent`).

(3) **gitignore + tests.** Remove the `work-plugins/*` lines from `.gitignore`
and add `agents/worker-*.md` beside the existing `agents/practice-scout.md`
line (sidecars stay covered by the `**/*.managed-file-dont-edit` glob). Invert
the test groups (see Test notes). Run `promptctl render-plugin-templates
--project-root <planctl_root>` locally so the rendered agents exist for the
check-generated guard; the rendered files stay gitignored.

This is additive/backward-compatible at runtime: `plan:worker-<tier>` resolves
because the `plan` plugin is always loaded; the old `--plugin-dir` plugin just
goes unused until keeper drops it (task 3).

### Investigation targets

**Required** (read before coding):
- template/agents/worker.md.tmpl:9-11 — `variants:` (keep), `render_to: work-plugins/{{ current_variant }}` (delete), `manifest_description:` (delete); set `name: worker-{{ current_variant }}`
- apps/promptctl/promptctl/run_render_plugin_templates.py `_render_agents` / `_resolve_agent_output` (in ~/code/arthack) — confirms default branch emits `agents/<stem>-<variant>.md` and returns it directly when `render_to` is absent
- template/skills/work.md.tmpl — warm spawn ~95-100, cold-resume spawn ~155-159; stale prose at ~7-9, 21, 48, 62, 64, 148, 195; the `worker_agent_id` capture-regex prose ~104
- tests/test_work_skill_consistency.py — Group C 157-259 (`test_old_tier_suffixed_agent_files_removed` INVERTS: files must now EXIST; `test_work_plugin_worker_agent_rendered_and_pinned` repoints to `agents/worker-<tier>.md`, `name: worker-<tier>`); Group D 262-381 (spawn-shape polarity flips: require envelope-driven `plan:worker-<tier>`, forbid bare `work:worker`); `_WORK_PLUGINS_DIR`:178 and `_DELETED_AGENT_BASENAMES`:181 become obsolete
- .gitignore:19-24 (work-plugins lines, delete), :28 (`**/*.managed-file-dont-edit` glob, keep), :32 (`agents/practice-scout.md`, mirror for `agents/worker-*.md`)
- .claude-plugin/plugin.json — confirms plugin name is `plan` (→ `plan:worker-<tier>`)

### Risks

Worker files MUST be flat in `agents/` (a subfolder would scope them
`plan:workers:worker-<tier>` and break the emitted name). Keep the rendered
filename and the `name:` frontmatter both `worker-<tier>` so the emitted
`worker_agent` resolves. The skill change depends on task 1's `worker_agent`
field existing — that is the declared dep.

### Test notes

After inversion, Group C asserts `agents/worker-<tier>.md` exists for each
tier with the right frontmatter; Group D asserts the skill spawns an
envelope-driven `plan:worker-<tier>` and carries no bare `work:worker`. Run
the render before the suite so the generated agents are on disk. Full planctl
suite + ruff + ty green.

## Acceptance

- [ ] `template/agents/worker.md.tmpl` has no `render_to:` / `manifest_description:`, keeps `variants:`, sets `name: worker-{{ current_variant }}`, narrowed internal description
- [ ] `promptctl render-plugin-templates` emits `agents/worker-{medium,high,xhigh,max}.md` (flat, gitignored, sidecar) addressable `plan:worker-<tier>`
- [ ] both `/plan:work` spawn sites pass through the envelope's `worker_agent`; null `worker_agent` → typed stop, not a spawn; no bare `work:worker` anywhere in the template
- [ ] `.gitignore` drops work-plugins lines, adds `agents/worker-*.md`
- [ ] Group C/D tests inverted and green; full planctl suite + ruff + ty green

## Done summary

## Evidence
