## Overview

Invert fn-593: move worker tier-routing out of keeper's `--plugin-dir` launch
flag and into the `/plan:work` skill's spawn line, driven by a `worker_agent`
name that planctl emits. Today N per-tier plugins under `work-plugins/<tier>/`
each ship an agent named `worker` (all colliding on the bare literal
`work:worker`); keeper loads exactly one per session via
`--plugin-dir work-plugins/<tier>`. After this change, four distinctly-named
worker agents (`worker-medium` … `worker-max`) live as generated files in the
`plan` plugin's own `agents/` directory (addressable `plan:worker-<tier>`),
a shared helper maps `tier → "plan:worker-<tier>"`, and `claim` /
`worker resume` / `resolve-task` emit that string as `worker_agent`. The
`/plan:work` skill becomes a pure pass-through that spawns
`Task(subagent_type=<worker_agent>)`; keeper drops the `--plugin-dir` push and
the `work-plugins/` tree is deleted. End state: one always-loaded plugin owns
tier routing via the emitted agent name, no per-tier plugin, no launch-flag
coupling.

## Quick commands

- planctl: `uv run pytest tests/ && uv run ruff check . && uv run ty check`
- keeper: `cd ~/code/keeper && bun test --parallel --timeout=30000`
- render check: `promptctl render-plugin-templates --project-root <planctl_root>` then confirm `agents/worker-{medium,high,xhigh,max}.md` exist with `name: worker-<tier>`, `model: opus`, `effort: <tier>`
- dispatch smoke: claim a real task and confirm `worker_agent` rides the envelope: `planctl claim <task_id> | grep worker_agent`

## Acceptance

- [ ] Shared `tier → "plan:worker-<tier>"` helper lives once (in `models.py` beside `TASK_TIERS`); `claim`, `worker resume`, and `resolve-task` all emit a `worker_agent` field via it
- [ ] `agents/worker-<tier>.md` renders for all four tiers from `template/agents/worker.md.tmpl` (no `render_to:`, no per-tier plugin manifest), gitignored + sidecar-guarded like `agents/practice-scout.md`
- [ ] `/plan:work` spawns the envelope's `worker_agent` at both warm and cold spawn sites; no bare `work:worker` literal remains anywhere
- [ ] keeper no longer passes `--plugin-dir` (autopilot + resume paths); keeper still reads `task.tier` for board/projection; keeper suite green
- [ ] `work-plugins/` tree deleted; planctl + keeper test suites green; all docs present-tense (no "formerly work-plugins" tombstones)
- [ ] null-tier (legacy) task surfaces a clean typed stop at the skill spawn site, not a `plan:worker-None` crash

## Early proof point

Task that proves the approach: task 2 (worker agents into `agents/` + skill
pass-through). If promptctl's default agents branch does NOT emit
`agents/worker-<tier>.md` per variant when `render_to:` is removed (it should,
per `_render_agents`), stop and re-derive the render mechanic before touching
keeper or deleting anything.

## References

- fn-593 established the per-tier-plugin + `--plugin-dir` model this epic inverts.
- promptctl `_render_agents` (apps/promptctl/promptctl/run_render_plugin_templates.py): the default (non-`render_to`) agents branch already emits `agents/<stem>-<variant>.md` per variant — removing `render_to:` is the whole mechanic.
- Claude Code sub-agents docs: flat `agents/` files are addressed `<plugin>:<name>`; a subfolder becomes part of the scoped id (would yield `plan:workers:worker-medium`), so worker files MUST stay flat in `agents/`. The `description` field is the sole auto-delegation signal — worker descriptions are narrowed to internal-only so four in-scope tiers never auto-trigger.
- `CLAUDE_CODE_SUBAGENT_MODEL` env var overrides every agent's `model` frontmatter — if set in the autopilot env it silently flattens all tiers to one model. Noted in CLAUDE.md.
- `agents/practice-scout.md` is the precedent: a generated, gitignored agent with a `.managed-file-dont-edit` sidecar.

## Rollout

The keeper daemon runs from source (`bun run src/daemon.ts`), so *merging* the
keeper change is not the cutover — *restarting keeperd* is. Until keeperd is
bounced it keeps passing `--plugin-dir work-plugins/<tier>`; deleting
`work-plugins/` under a live old daemon breaks dispatch (flag points at a
deleted dir). Task ordering makes the keeper flag-drop (task 3) the **gating
task**; the human-driven cutover wraps it:

1. await the gating task (keeper flag-drop, task 3) to START
2. turn OFF autopilot (quiesce — no new dispatch; the in-flight gating worker drains)
3. await the gating task to COMPLETE
4. bounce keeperd (now running flag-dropped code — no `--plugin-dir`)
5. re-enable autopilot → the `work-plugins/` deletion (task 4) then dispatches under the new daemon

This whole epic is additionally gated behind `fn-766` (an unrelated keeper
epic that must drain first) so it runs with sole autopilot access. Note: tasks
1–2 are additive and backward-compatible — even under the old daemon the skill
already spawns `plan:worker-<tier>` (the `--plugin-dir` plugin just goes unused)
— so only the deletion (task 4) is unsafe before the bounce.
