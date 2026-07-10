# 33. Launch triples over a named preset catalog

## Status

Accepted. Partially supersedes ADR 0010: only its preset-catalog clause ("the preset
catalog auto-generates one `<provider>-<model>` preset per roster pair in memory at
load"); the model-axis, wrapped-cell, and pecking-order decisions stand.

## Context

Launch configuration named presets twice: a hand-authored catalog (`presets.yaml`)
pinning harness + model + effort under invented names, and an in-memory
`<provider>-<model>` augmentation minted from the matrix roster. Panels, pairing,
dispatch, and the per-harness defaults all referenced presets by name, so renaming a
catalog entry silently re-bound every referrer — observed live when panel members
degraded from pinned-effort hand presets to effort-less auto presets after a rename.
Meanwhile the matrix already knew the full harness × model space, while its effort
axis was one global list even though real models want narrower sets. Two notions of
"model" coexist and must not be conflated: the plan-cell capability axis (task
`{model, tier}`, renderer, selector, wrapped routing — ADR 0010) and the launch
surface naming one specific harness + native model id + effort.

## Decision

The launch surface adopts the launch triple `<harness>::<model>::<effort>` as its
sole reference format, and the named preset catalog retires. A triple is
context-free: exactly three `::`-separated segments — a registered harness, a
harness-native model id carried verbatim to the launch flag, and a keeper effort
token translated per harness through descriptor data (an axis-less harness takes the
fixed sentinel `na`). Every well-formed triple is launchable; the matrix enumerates
blessed combinations for discovery and doctor lint, never as a launch gate. Colons
are banned inside segments, and a triple is slugified before entering any tmux,
window, or file name, so `verb::id` composite keys keep parsing unchanged.

The matrix grows to describe the whole cube: per-provider and per-model `efforts`
overrides (most-specific wins: model → provider → top level), a model long form
`{name, native?, efforts?}` replacing the one-pair alias map, and a per-provider
`route` flag whose false value declares a launch-only provider — enumerated for
triples, excluded from the wrapped-cell pecking order and the plan capability axis.
`presets.yaml` slims to the per-harness default triples plus the `worker` and
`escalation` machine-launch triples (their fail-open coalescing onto embedded
constants preserved); panel members are triples, a duplicated member distinguished
by ordinal for leg naming and judge attribution. The plan-cell world is untouched:
tasks keep `{model, tier}` capability tokens, and a triple never enters a fold, the
board, or the selector.

Rejected: strict load-time validation of configured triples against the matrix
(re-gates the virtual-preset property and blocks models configured ahead of the
roster — the providers doctor lints instead); a separate harness-enumeration key
beside `providers` (two rosters that must agree); triples on the plan-cell axis
(forfeits the model-axis-subsumes-harness invariant and churns folds for no gain).

## Consequences

- Dangling-name drift is structurally impossible: config carries the launch spec
  itself, never a reference to a mutable catalog entry.
- Typo detection moves from catalog load to the providers doctor and the harness
  launch; the doctor lints host triples against the enumerable cube.
- Both firewalled matrix parsers (launcher island, plan island) carry the schema in
  lockstep under the parity test; the effort cube is jagged, so every consumer reads
  the per-model effort list, never the global axis.
- The judge attributes panelists by triple + ordinal, keeping duplicate same-triple
  legs distinct.
