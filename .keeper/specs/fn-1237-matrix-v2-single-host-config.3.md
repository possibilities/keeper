## Description

**Size:** M
**Files:** plugins/prompt/src/render_plugin_templates.ts, plugins/plan/template/agents/worker.md.tmpl, plugins/prompt/test/parity.test.ts, plugins/plan/test/consistency-generated-guard.test.ts, prompt/plan test fixtures

### Approach

The renderer requires the host matrix: pluginEffectiveMatrix stops composing over `<pluginDir>/subagents.yaml`
and reads the v2 host matrix through the plan island's loader (the import edge already exists); an absent or
bad matrix aborts the render with the typed four-state error — no partial tree. Cell-template membership
re-sources from `subagent_templates` (same `includes(tmplRel)` shape as today). Fan-out walks
`subagent_models × effortsFor(capability)` with the driver derived from claude-membership, rendering to the
FIXED convention `workers/<model>-<effort>/agents/…` plus the per-cell plugin.json — the destination derives
from the plan leaf module's WORKERS_BASE/workerCellDir (task 1) so the convention has ONE code home; if a
direct cross-package import is unreasonable, pin engine constant == plan constant with a conformance test
instead. Delete the render_to machinery outright: the strip regex, the per-template destination resolution,
and its path-escape guards — escape safety moves to load-time validation of subagent_templates entries
(task 1) plus the derived-capability charset; keep `manifest_description:` required, re-keyed on inventory
membership (a listed template missing it still errors). Drop `render_to:` from worker.md.tmpl frontmatter.
Re-source consistency-generated-guard's expected cell set from the v2 host matrix under a pinned
KEEPER_CONFIG_DIR fixture. Non-cell template rendering must stay byte-identical (prompt parity suite).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/prompt/src/render_plugin_templates.ts:19-32 — the render_to contract comments; :60 RENDER_TO_STRIP_RE; :134-139 pluginEffectiveMatrix; :445-507 resolveAgentOutput (destination + manifest emit + escape guards); :529 membership gate; :570-590 the ragged fan-out loop
- plugins/plan/template/agents/worker.md.tmpl — frontmatter to prune (render_to: goes; manifest_description: stays)
- plugins/plan/test/consistency-generated-guard.test.ts:32, 122-160 — gitignored-tree guard computing the ragged product; re-source from v2
- plugins/prompt/test/parity.test.ts:402, 437 — existing temp-matrix writes to convert to pinned fixtures

**Optional** (reference as needed):
- plugins/plan/src/worker_cells.ts — task 1's leaf module exporting WORKERS_BASE/workerCellDir (the one destination home)

### Risks

- The prompt engine is generic — deleting render_to must not perturb non-cell template rendering (parity suite is the guard)
- The engine↔plan destination-convention drift once the frontmatter agreement point is gone — one import or one conformance test, decided at the seam

### Test notes

Render against the multi-provider fixture: assert the exact ragged cell set, wrapped cells carrying
wrapper_driver frontmatter, native cells their own model/effort; assert abort-with-typed-error on each bad
state writes nothing; assert an escaping subagent_templates entry is rejected upstream.

## Acceptance

- [ ] Rendering with a multi-provider v2 fixture produces exactly the subagent_models × per-capability-efforts cell tree — wrapped cells carry the wrapper-driver frontmatter, native cells their own model/effort — asserted by the generated-tree guard over the fixture
- [ ] Rendering with an absent or invalid matrix fails with the typed state-named error and writes no partial tree
- [ ] No template or engine code references render_to:; the worker template renders identically to a cell whose destination came from the fixed convention
- [ ] The workers/<model>-<effort> destination convention has exactly one code home shared with the plan island (import or conformance-pinned equality)
- [ ] Per-cell plugin.json still carries manifest_description; an inventory-listed template missing it errors

## Done summary

## Evidence
