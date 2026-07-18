# 0047 — Provider-equivalence map and worker-provider dispatch constraint

## Status

Accepted (number PROVISIONAL until landed; fan-in renumber per ADR 0020/0022). Relates to ADR
0036 (host matrix cell axes and eligibility), ADR 0040 (per-verb dispatch table), ADR 0011/0018
(selection-review attribution), and ADR 0079 (per-launch account routing, which likewise rejects
durable conversation affinity); the Provider constraint directs *dispatch translation* only.

## Context

The worker fleet spans two provider families: claude-native cells (opus, sonnet) and codex-served
wrapped cells (the GPT tiers). Operators need to shift the whole board's work dispatch onto one
family — quota walls, cost windows, provider outages — without re-running selection or mutating
committed plans. That requires (a) a judgment artifact naming, for each dispatchable cell, its
most-equivalent cell in the other family, and (b) a dispatch-time constraint that applies it.
Neither existed; the nearest mechanisms (dispatch-table floors, the matrix pecking order) operate
on sessions or on providers serving one capability, not on translating a task's assigned cell
across families.

## Decision

- **The equivalence map is a separate committed artifact, `plugins/plan/provider-equivalence.yaml`.**
  It is neither `model-selector.yaml` (embedded in each selector brief; changes reset
  `config_hash` cohorts) nor host `matrix.yaml` (host config, not capability judgment). The unit
  is the full `(model, effort)` cell; directions are independently authored and need not invert
  (codex→claude is many-to-one); targets are worker-cell eligible. `/model-guidance` authors it;
  `model-guidance-check.ts` supplies structural `--check` and host-aware `--state` totality.
- **The Provider constraint is one durable nullable TEXT enum column,
  `autopilot_state.worker_provider`** (`NULL | claude | codex`), riding the generic
  `set_autopilot_config` patch — no new RPC. It is the first non-numeric config column; the patch
  machinery gains a string-enum branch.
- **Translation is producer-only and happens in the pure reconcile pass.** The parsed map and the
  Provider constraint ride the `ReconcileSnapshot` (like `hostMatrix` and `worktreeMode`);
  `reconcile()` translates the Cell assignment and every `PlannedLaunch` carries the Cell assignment
  plus its Dispatched cell so the producer's re-resolution, the exec-boundary env carrier,
  forensics, and manual `keeper dispatch` read one consistent value. Plans stay read-only —
  `task.model`/`task.tier` and the selection sidecar never mutate — and no fold ever reads the map
  (re-fold determinism).
- **Fail closed, no fallback.** An untranslatable cell refuses dispatch into the sticky
  `DispatchFailed` surface with distinct reasons (no map entry / target not on this host / map
  malformed — remediation differs), and a missing mapping never silently keeps the original
  provider: compliant-looking status over a violated constraint is the worst failure mode. Scope is
  cell-bearing `work` dispatches only; close/escalation verbs stay on their dispatch-table floors.
- **The Dispatched cell is recorded in `.keeper` task runtime metadata at claim**, carried by
  always-emitted exec-boundary env; written only when a Provider constraint actually fired, absent
  means ran-as-assigned. An ALREADY_MINE re-claim without a Provider constraint preserves its
  stamped Dispatched cell, while a later claim without one clears it. Last-write-wins per task;
  per-attempt history stays in keeper.db.
- **Envelope corollary:** claim, worker resume, and resolve-task surface the stamped Dispatched
  cell beside `worker_model`. The three fields are absent when no Dispatched cell is stamped, so
  cold resume validates the same launch truth as the original claim.
- **Attribution: cell-review grades the Dispatched cell** (what actually ran); the selection-audit
  brief carries both cells plus the constraint; selector-policy cohort aggregation **excludes
  constrained runs** — their grades are evidence about the equivalence map's quality (feeding
  `/model-guidance`), never about the selector's choice, avoiding execution-mislabeling
  contamination of selector cohorts.

## Consequences

- Applying a Provider constraint reduces but does not evacuate a provider: close/escalation
  sessions and the Wrapped cells' claude wrapper driver stay claude-side. Full evacuation would
  require provider-aware cell-less dispatch — deliberately out of scope here.
- A Provider constraint for claude collapses seven GPT tiers onto two claude models; the CLI
  surfaces the collapse and the "work cells only" scope so the projection is never surprising.
- A host-matrix axis change makes the map non-total until `/model-guidance` backfills; `--state`
  classifies the gap and affected dispatches fail closed in the interim.
- The equivalence-map loader respects the two-island import boundary (plan island vs launcher
  island), mirroring the dual `matrix.yaml` parsers rather than adding a cross-island edge.

## Amendment — family label `codex` → `gpt`

The non-claude provider-family label was renamed `codex` → harness-neutral `gpt`, decoupling the
dispatch label from the codex *harness* serving GPT tiers. `worker_provider` is now
`NULL | claude | gpt`; map directions are `claude_to_gpt` / `gpt_to_claude`. `codex` remains a
write-time CLI/RPC/reducer alias normalized to `gpt`; reads are strict, and fold normalization
preserves re-fold determinism for historical events. A `v122` backfill rewrites the durable column.
