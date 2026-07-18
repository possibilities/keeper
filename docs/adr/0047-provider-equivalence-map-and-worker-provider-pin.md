# 0047 — Provider-equivalence map and worker-provider dispatch pin

## Status

Accepted (number PROVISIONAL until landed; fan-in renumber per ADR 0020/0022). Relates to ADR 0036
(required host matrix — the cell axes and worker-cell eligibility), ADR 0040 (per-verb dispatch
table — the session triples cell-less verbs keep), ADR 0011/0018 (selection review — the grading
surface whose attribution this record settles), and ADR 0079 (per-launch account routing — a
sibling bounded context that likewise rejects durable pinning of conversations; the worker
provider pins *dispatch translation*, never account affinity).

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
  Not a `model-selector.yaml` section: that file is embedded verbatim in every selector brief and
  its sha256 is the `config_hash` keying cell-review cohorts — dispatch policy there would bloat
  every brief and reset cohorts on every equivalence tweak. Not host `matrix.yaml`: equivalence is
  committed capability judgment, not per-host config. The unit is the full `(model, effort)` cell
  (equivalence is not separable across effort bands; the matrix is ragged); the two directions are
  authored independently and are never inverses (codex→claude is many-to-one); targets are
  restricted to the worker-cell eligibility list. `/model-guidance` authors and refreshes it; a
  strict structural gate (`--check`, host-blind, unknown keys rejected) plus host-aware totality
  (`--state`, both directions against the live matrix's dispatchable cells) extend
  `model-guidance-check.ts`.
- **The pin is one durable nullable TEXT enum column, `autopilot_state.worker_provider`**
  (`NULL | claude | codex`), riding the generic `set_autopilot_config` patch — no new RPC. It is
  the first non-numeric config column; the patch machinery gains a string-enum branch.
- **Translation is producer-only and happens in the pure reconcile pass.** The parsed map and the
  pin ride the `ReconcileSnapshot` (like `hostMatrix` and `worktreeMode`); `reconcile()` translates
  the assigned cell and every `PlannedLaunch` carries assigned + effective cells so the producer's
  re-resolution, the exec-boundary env carrier, forensics, and manual `keeper dispatch` read one
  consistent value. Plans stay read-only — `task.model`/`task.tier` and the selection sidecar never
  mutate — and no fold ever reads the map (re-fold determinism).
- **Fail closed, no fallback.** An untranslatable cell refuses dispatch into the sticky
  `DispatchFailed` surface with distinct reasons (no map entry / target not on this host / map
  malformed — remediation differs), and a missing mapping never silently keeps the original
  provider: compliant-looking status over a violated constraint is the worst failure mode. Scope is
  cell-bearing `work` dispatches only; close/escalation verbs stay on their dispatch-table floors.
- **The dispatched cell is recorded in `.keeper` task runtime metadata at claim**, carried by
  always-emitted exec-boundary env (empty when unconstrained, so claim clears a stale value);
  written only when a constraint actually fired, absent means ran-as-assigned. Last-write-wins per
  task; per-attempt history stays in keeper.db.
- **Attribution: cell-review grades the dispatched cell** (what actually ran); the selection-audit
  brief carries both cells plus the constraint; selector-policy cohort aggregation **excludes
  constrained runs** — their grades are evidence about the equivalence map's quality (feeding
  `/model-guidance`), never about the selector's choice, avoiding execution-mislabeling
  contamination of selector cohorts.

## Consequences

- Pinning reduces but does not evacuate a provider: close/escalation sessions and the wrapped
  cells' claude wrapper driver stay claude-side. Full evacuation would require provider-aware
  cell-less dispatch — deliberately out of scope here.
- Pinning to claude collapses seven GPT tiers onto two claude models; the CLI surfaces the
  collapse and the "work cells only" scope so the projection is never surprising.
- A host-matrix axis change makes the map non-total until `/model-guidance` backfills; `--state`
  classifies the gap and affected dispatches fail closed in the interim.
- The equivalence-map loader respects the two-island import boundary (plan island vs launcher
  island), mirroring the dual `matrix.yaml` parsers rather than adding a cross-island edge.

## Amendment — family label `codex` → `gpt`

The non-claude provider-family label was renamed `codex` → harness-neutral `gpt`, decoupling the
dispatch label from the codex *harness* serving the GPT tiers. `worker_provider` is now
`NULL | claude | gpt`; map directions `claude_to_gpt` / `gpt_to_claude`. `codex` stays a deprecated
input alias on every write seam (CLI, RPC, reducer fold) normalized to `gpt` — an existing pin
survives; reads are strict (a stray `codex` reads unset); the fold normalization is load-bearing for
re-fold determinism (historical events carry `codex`). A `v122` backfill rewrites the durable column value. The codex *harness* is a separate concern, unchanged; the bodies above keep the old spelling as history.
