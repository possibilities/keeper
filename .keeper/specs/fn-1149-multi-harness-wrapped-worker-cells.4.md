## Description

**Size:** M
**Files:** plugins/plan/src/subagents_config.ts, plugins/plan/subagents.yaml, plugins/prompt/src/render_plugin_templates.ts, plugins/prompt/test/parity.test.ts, plugins/prompt/test/oracle/fixtures/render-plugin-templates.json, plugins/prompt/test/oracle/fixtures/check-generated.json

### Approach

The plan island learns the effective matrix: subagents_config gains a host-matrix reader
(its own small parser — the plan island cannot import src/agent) that prefers the host
matrix file when present and falls back to the embedded subagents.yaml snapshot (all
models native, wrapper_driver defaulting sonnet/high). The compile-time text embed stays
load-bearing for the compiled plan binary. effectiveMatrix() exposes models, efforts,
driverFor, and wrapper_driver to both consumers. The prompt renderer keeps importing the
plan loader (the existing cross-island precedent) and its agent fan-out binds three new
per-cell variables — current_driver, wrapper_model, wrapper_effort — alongside
current_model/current_effort. Prune the stale single-source-of-truth claim from the
subagents.yaml header, describing it as the embedded default the host matrix overrides.
All render tests pin the embedded defaults through a sandboxed config dir so suites stay
host-independent.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/subagents_config.ts:1-60 — dual-mode loader, typed error, lazy embed parse
- plugins/prompt/src/render_plugin_templates.ts:55 and :127-132 and :509-607 — the cross-island import, pluginSubagentsMatrix, and the fan-out to extend
- plugins/plan/subagents.yaml:1-33 — header prose carrying the stale single-source claim

**Optional** (reference as needed):
- plugins/prompt/src/render_engine.ts:57-118 — Liquid engine, strictVariables (unbound vars fail loud)
- plugins/prompt/test/parity.test.ts and the two oracle fixtures — the gates that move

### Risks

- strictVariables means every matrix-listed template render fails loud until the new
  bindings are passed — renderer and template land in separate tasks, so this task must
  keep the existing template rendering green (bindings added, template consumes them later).
- Host-config leakage into the fast suite: every render test must sandbox the config dir.

### Test notes

Two fixture paths: no matrix (byte-identical tree to today) and a fixture matrix with one
wrapped model (cells emitted per capability model x effort, driver-correct bindings).
Parity + check-generated + oracle fixtures green in both.

## Acceptance

- [ ] With no host matrix the rendered workers tree is byte-identical to today's output.
- [ ] With a fixture matrix the fan-out emits one cell per capability model and effort,
      each rendered with driver-correct bindings.
- [ ] Render, parity, and generated-file gates pass under a sandboxed config dir, and the
      plan binary's embedded fallback still works from an arbitrary cwd.

## Done summary

## Evidence
