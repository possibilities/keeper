## Overview

Replace the named preset catalog with matrix-derived launch triples `<harness>::<model>::<effort>` per ADR 0033. The matrix becomes the single description of the launchable cube (per-provider/per-model effort overrides, launch-only providers via `route: false`); `presets.yaml` slims to four `<harness>_default` triples plus the `worker`/`escalation` machine-launch triples; `panel.yaml` members become triples with ordinal-disambiguated duplicates. The plan-cell world (task `{model, tier}`, worker-cell rendering, selection, wrapped routing) stays capability-based — a triple never enters a task, a fold, or the board.

## Quick commands

- `bun test test/agent-matrix.test.ts test/agent-config.test.ts test/agent-presets.test.ts test/pair-panel.test.ts` — launcher-island config surface green
- `cd plugins/plan && bun test` — plan island + cross-island parity green
- `keeper agent presets list --json` — emits the virtual cube (triples per harness, effective efforts per model, four defaults)
- `keeper agent providers check` — doctor lints host triples against the enumerable cube (drift = exit 9)
- `keeper prompt render-plugin-templates && cd plugins/plan && bun test` — ragged cell render + drift gates agree

## Acceptance

- [ ] Every launch-naming surface (agent launch, pair, panel members, dispatch --preset, harness defaults, worker/escalation) accepts exactly the triple grammar; named catalog presets no longer parse anywhere
- [ ] matrix.yaml supports per-provider and per-model effort overrides (clobber, most-specific wins) and `route: false` launch-only providers, identically in both firewalled parsers under the parity test
- [ ] `presets list --json` enumerates the full virtual cube; `providers check` flags well-formed host triples outside the cube as drift findings
- [ ] Panel duplicate triples run as distinct ordinal-labeled legs and the judge attributes by triple + ordinal
- [ ] All skill/agent/doc prose teaches the triple grammar; no prose references the named preset catalog

## Early proof point

Task that proves the approach: ordinal 1 (matrix schema in both parsers + parity fixtures). If the two-island schema extension can't stay parity-clean, stop and rethink the schema shape before any consumer moves.

## References

- docs/adr/0033-launch-triples-over-named-preset-catalog.md — the settled decision (partially supersedes ADR 0010's auto-preset clause)
- docs/adr/0010-host-provider-matrix-and-wrapped-worker-cells.md — model-axis/wrapped-cell/pecking-order invariants that stay
- CONTEXT.md "Panels and launch triples" — Launch triple, Launch-only provider, Panel vocabulary
- fn-1229 adjacency: different prompt-corpus snippet files, both plans re-vendor the corpus — land order is free but re-vendor after merge, not from a stale checkout

## Alternatives

- Transitional dual-accept of legacy preset names: rejected — single-host deployment, sandboxed tests, and install-time file migration make the window pure ceremony
- Separate harness-enumeration key beside providers: rejected in ADR 0033 (two rosters that must agree)
- Load-time strict validation of configured triples against the cube: rejected in ADR 0033 (re-gates the virtual-preset property); the doctor lints instead

## Architecture

```mermaid
flowchart LR
  M[matrix.yaml\nefforts + providers\n(route, per-model efforts)] -->|launcher parser src/agent/matrix.ts| E[enumerateTriples\npresets list / doctor]
  M -->|plan parser plugins/plan/src/host_matrix.ts| C[capability cells\nworkers/model-effort]
  P[presets.yaml\n4 defaults + worker + escalation triples] --> L[launch resolution]
  Y[panel.yaml\ntriple members + ordinals] --> L
  E -. lint .-> P
  E -. lint .-> Y
  L -->|parse triple, per-harness flag translation| H[claude / codex / pi / hermes argv]
```

Route-disabled providers appear only on the enumeration edge, never the capability edge. Triples are parsed once at load; slugified forms are derived for tmux/window/file names only.

## Rollout

Land the epic, then operator steps on this host: (1) install/reload keeper; (2) rewrite `~/.config/keeper/matrix.yaml` (add pi as `route: false` with the native-id long form), `presets.yaml` (four default triples + worker/escalation), `panel.yaml` (triple members — fixes the live claude-opus/claude-sonnet effort drift); (3) `keeper agent providers check` until clean; (4) smoke a pair launch and a panel run. Rollback = revert the epic merge and restore the previous three host files from git-less backups (`cp *.yaml *.yaml.bak` before editing).

## Docs gaps

- **docs/install.md**: extend the host-matrix walkthrough with effort overrides, route flag, and triple-based presets list/resolve
- **docs/problem-codes.md**: reshape the presets/providers JSON specs and retire the auto-preset collision text
- **docs/plugin-composition-map.md**: worker/escalation wiring now points at triple-valued keys
- **plugins/plan/README.md**: worker-matrix section drops the auto-generated preset-catalog paragraph
- **docs/examples/matrix.example.yaml**: demonstrate overrides + route flag (anti-rot-tested golden — extend in place)

## Best practices

- **Grammar, not split**: validate segment count and per-segment charset, reject loudly; ban bare `:` inside segments so `::` is the only colon site [LangSec/parser-differential literature]
- **Slug is display, triple is identity**: route and dedupe on the raw triple; slugs get deterministic disambiguation because slugification is non-injective [slug-collision precedent]
- **Clobber, don't merge** for most-specific-wins list overrides; absent inherits, present-empty fails loud [dbt/Dynaconf/.NET precedent]
- **Parity as enum-inventory + differential fixtures**: both parsers must expose the identical vocabulary and reject the identical invalid rosters [parser-differential vulnerability class]
- **Strict string typing for YAML scalars** so Norway-problem coercions (no/off/version-like ids) fail loud instead of parsing as booleans/numbers
