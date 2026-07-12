## Overview

Two coupled pieces: a committed cross-provider equivalence map — every dispatchable GPT
{model, effort} worker cell mapped to its most-equivalent Claude cell and vice versa,
authored by /model-guidance and drift-gated — and a durable `autopilot_state.worker_provider`
setting (NULL | claude | codex) that pins work dispatches to one provider family by
translating each task's assigned cell through the map at launch. Producer-only (the board
never mutates), fail-closed (an untranslatable cell refuses dispatch, never silently keeps
its provider), with the dispatched cell recorded in `.keeper` task runtime metadata alongside
the untouched assignment so selection research grades the cell that actually ran. Decision
record: docs/adr/0047.

## Quick commands

- `bun plugins/plan/scripts/model-guidance-check.ts --check` — equivalence map structural gate stays green
- `bun plugins/plan/scripts/model-guidance-check.ts --state | jq .equivalence` — totality vs the live matrix
- `keeper autopilot config worker_provider codex && keeper autopilot show` — set + read the pin
- `keeper query dispatch-failures` — fail-closed refusals surface as sticky rows
- `bun run test:full` — all three suites green

## Acceptance

- [ ] `plugins/plan/provider-equivalence.yaml` exists, schema-versioned, total in both directions over the dispatchable cells, and the drift gate (--check structural, --state totality) fails on any gap, unknown key, or same-family target
- [ ] `keeper autopilot config worker_provider <claude|codex|none>` round-trips through the generic set_autopilot_config patch and renders in `keeper autopilot show` with its work-cells-only scope named
- [ ] With the pin active, an assigned cell from the other family dispatches its mapped equivalent (`--plugin-dir workers/<mapped>/`), and an untranslatable cell mints a sticky DispatchFailed with a reason that names which of no-map-entry / target-not-on-host / map-malformed applies
- [ ] A constrained run records `dispatched_model`/`dispatched_tier`/`dispatch_constraint` in `.keeper` task runtime at claim; an unconstrained claim clears stale values; assigned `task.model`/`task.tier` and the selection sidecar never change
- [ ] The selection-audit brief carries both cells plus the constraint, the auditor grades the dispatched cell, and selector-policy cohort aggregation excludes constrained runs
- [ ] Docs updated: model-guidance + autopilot + cell-review skills, plugins/plan README and CLAUDE.md drift-gate row, problem-codes reject reasons

## Early proof point

Task that proves the approach: `.1` (map schema + strict parser + gate). If the strict-parse /
totality design fights the existing model-guidance-check structure, fall back to a sibling
standalone check script mirroring panel-guidance-check.ts — one sentence of rework, no seam change.

## References

- docs/adr/0047-provider-equivalence-map-and-worker-provider-pin.md — the settled decisions and their rationale
- docs/adr/0036 (required host matrix), 0040 (per-verb dispatch table), 0011/0018 (selection review) — lineage
- CONTEXT.md: Equivalence map, Worker provider, Dispatched cell, Selection review (updated referent)
- Precedent for tier-slot → provider-model indirection: musistudio/claude-code-router, BerriAI/litellm (config-driven re-route at dispatch, never hardcoded constants)

## Docs gaps

- **plugins/plan/README.md**: cell/host-matrix section gains the assigned→dispatched distinction; model-guidance row gains provider-equivalence.yaml; selection coverage notes both-cells briefs
- **plugins/plan/skills/model-guidance/SKILL.md**: scope statement + drift-gate wording now cover the second artifact
- **plugins/keeper/skills/autopilot/SKILL.md**: worker_provider config row, show envelope field, take-over capture/restore set
- **plugins/plan/CLAUDE.md**: model-guidance drift-gate row mentions the equivalence map
- **docs/problem-codes.md**: new worker-cell launch reject reasons

## Best practices

- **Break-it-first gate proof:** a deliberately-invalid fixture MUST fail --check — a passing gate on known-bad input is the only proof the gate works [Yamale/RAPIDS]
- **Execution mislabeling:** grade the realized cell, never train selector policy on runs the selector did not cause [model-routing literature]
- **Alias re-point staleness:** a provider re-pointing a launch id is a re-research trigger the deterministic gate cannot see; the skill owns it
- **No network in the gate:** pure parse + totality over committed data; provider APIs are flaky and non-deterministic in CI
- **Override observability:** refusals must spike visibly (sticky rows) rather than silently starving the board
