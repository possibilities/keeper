# 36. Required host matrix v2 with launch-id model entries

## Status

Accepted. Partially supersedes 0010 (embedded-defaults fallback, `native:`
alias grammar, `route:` flag); the provider-roster/wrapped-cell architecture
recorded there stands. ADR 0063 partially supersedes only this record's
renderer-owned worker-publication mechanism; the required matrix and its cell
topology stand.

## Context

The worker `{model × effort}` matrix lived in two configs: an in-repo
`plugins/plan/subagents.yaml` (embedded into the compiled plan binary at
build time and imported by the daemon's fs-free reconcile closure) and an
optional host-level `~/.config/keeper/matrix.yaml` overlaying it per ADR
0010. Absent the host file, every surface silently degraded to the embedded
claude-only defaults — a fail-open an operator could not distinguish from a
correctly configured claude-only host, discovered only when wrapped cells
stopped being selected. The schema carried ceremony that existed to bridge
the two files: a `name:`/`native:` long form declaring which axis token a
provider-qualified launch id resolved from, a `route:` flag excluding a
provider from the wrapped-cell pecking order while keeping it launchable,
and a `subagents:` key parsed then discarded because the template inventory
came from the embedded file. Each in-repo role that appeared to force the
embed dissolved on inspection: the compiled binary needed it only because it
has no plugin-relative path (the host matrix is at an absolute
`KEEPER_CONFIG_DIR` path); the reconcile closure's no-fs boundary constrains
imports, not injected data; the rendered `workers/` tree is gitignored
host-derived output, not a committed artifact needing a repo axis; and CI's
coverage gates can anchor to committed test fixtures while integrity checks
stay self-contained.

## Decision

Delete `subagents.yaml` and its embed machinery. `matrix.yaml` v2 is the
single worker-matrix config, required loudly on every host: top-level
`efforts`, `subagent_templates` (the cell-template inventory), and
`subagent_models` (the capability tokens that render and select as worker
cells), plus the provider roster. A provider model entry is the launch id
verbatim — the string the harness CLI receives — as a bare scalar or
`{id, efforts}` for a ragged effort band; the capability token is derived as
the segment after the last `/` (the whole id when slash-free), validated
non-empty against the strict token charset. The same derived capability
under multiple providers is one axis value: the first provider in the
pecking order serves it and owns its effort list, shadowed entries are
logged visibly; a duplicate capability within one provider fails loud.
`native:`, `name:`, and `route:` retire — launch-only enumeration falls out
of `subagent_models` membership per capability rather than a per-provider
flag, so a roster entry absent from `subagent_models` launches as a triple
but never enters the cell set. Launch triples stay capability-keyed (ADR
0033 unchanged); the launcher resolves capability → launch id from the
winning provider entry.

Absence and malformedness are typed loud errors everywhere the matrix is
read, discriminated into four states — absent, unparseable, schema-invalid
(a retired key is named in the rejection), and valid-but-empty — with the
error naming the resolved path and the fix (copy
`docs/examples/matrix.example.yaml`). The daemon never `fatalExit`s on a bad
matrix: the autopilot producer loads and validates once per reconcile cycle
and injects an immutable snapshot (parsed axes or the failure discriminator)
into the pure core, which parks dispatch behind a visible distress sticky
until the file is fixed; the fs-free import boundary of the reconcile
closure is unchanged. The Claude worker compiler reads the host matrix directly
and publishes the complete `subagent_templates × subagent_models × efforts`
cohort to the fixed `workers/<model>-<effort>` convention;
`render-plugin-templates` delegates that publication as a compatibility front
door. The inventory entries and derived capability token carry the
path-traversal guards. ADR 0063 owns the publication, verification, and
freshness contract. CI drift gates re-scope to what the repo can self-verify
(hash parity, structural validation, a schema-valid example) while axis-coverage
checks move host-side where the axis lives; test suites pin
`KEEPER_CONFIG_DIR` at committed claude-only fixtures.

Rejected: keeping a transformed in-repo default matrix (a second config
instance whose silent-fallback semantics were the original complaint);
template self-declaration via a frontmatter marker (an inventory that lives
nowhere beats co-located markers only when the host owns the fan-out, and
the operator does); an `as:`/`capability:` override for launch-id schemes
without `provider/model` structure (declined — out of scope until a real
provider needs it); a schema `version:` field (the v1-shaped-file case is
covered by naming the retired key in the rejection).

## Consequences

- A fresh host cannot render, select, or dispatch worker cells until
  `matrix.yaml` exists — activation is copying the shipped example; the
  error message carries that instruction. `keeper agent` provider resolution
  loses its absent-matrix claude-native fallback and fails loud the same way.
- Every work cell — claude-native included — now depends on the host matrix;
  there is no embedded baseline. A wedged matrix parks the whole board
  behind one distress sticky rather than degrading to claude-only.
- Basename derivation accepts a theoretical cross-provider collision (two
  different models sharing a trailing segment merge into one capability);
  model names are branded enough that the guard is the same-provider
  duplicate check plus visible shadow logging, not an alias override.
- The two hand-rolled island parsers (`src/agent/matrix.ts`,
  `plugins/plan/src/host_matrix.ts`) reshape in lockstep under the existing
  parity test; the relocated cell-path helpers live in a new fs-free leaf
  module inside the reconcile closure.
- In-flight tasks keep their stamped `plan:worker-<model>-<tier>` agents:
  capability tokens for existing models are byte-identical under v2.
