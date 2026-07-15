# 63. Compiler-owned Claude worker cohort

## Status

Accepted. Partially supersedes only ADR 0036's renderer-owned worker-publication
mechanism and extends ADR 0039's compiler ownership across targets. ADR 0036's
required matrix and worker-cell topology, and the wrapped runtime decisions in
ADRs 0010 and 0050, stand.

## Context

A task selects one worker cell at dispatch from its `{model, tier}` assignment;
a producer-side worker-provider constraint may translate that selected cell. The
cell set is matrix-derived, but publication had been coupled to the general
plugin-template renderer. That made a renderer invocation responsible for a
complete, runtime-critical cohort while leaving no single owner for its nested
plugin files, sidecars, inventory, or freshness proof.

The prompt compiler already owns target-scoped artifact publication for Pi
static agents. Claude work cells need the same target-scoped ownership without
turning them into task-specific prompt artifacts or moving provider decisions
from dispatch into compilation.

## Decision

`keeper prompt compile --role work:worker --target claude` (equivalently,
`--bundle plan:work`) publishes the complete matrix-derived shared Claude
worker cohort. A role- or bundle-scoped request is publication scope, not a
request to generate one task's artifact: every matrix cell is compiled.

The compiler snapshots the complete literal template-include graph and
fingerprints the catalog, matrix, and every captured source. It solely owns the
worker root, including nested plugin files, JSON sidecars, and its manifest. It
safely adopts valid legacy output, prunes only owned orphans, atomically writes
and verifies every artifact before publishing the manifest last, and supports a
write-free check mode.

`render-plugin-templates` remains a compatibility front door: it skips worker
writes and delegates exactly once to the compiler. Install and promote retain
that front door, while promotion verifies the compiler-owned cohort.

Manual and autopilot work dispatch verify current compiler fingerprint,
inventory, hashes, and selected-cell membership read-only before launch. An
absent selected manifest fails as `worker-cell-missing`; a present manifest
whose fingerprint, inventory, hashes, or membership is invalid fails as
`worker-cell-stale`. Both remediate with:
`keeper prompt compile --role work:worker --target claude`. Resolution accepts
only the exact selected physical cell as the preloaded `work` plugin. A
`work` plugin from configuration or cwd is a shadow, not a substitute.

Worker isolation is config-gated. With `worker_plugin_isolation` absent or
`off`, automated work launches retain `plugin_scan_dirs` results. With
`strip-scan-dirs`, they remove only those scan results; hard `plugin_dirs` and
cwd detection remain. Runtime shadow inventory mirrors the resolved gate.

Compilation preserves the matrix's worker-cell topology. Native cells launch
their exact Claude route. Wrapped cells retain their assigned and effective
capability while running the fixed wrapper driver at `maxTurns: 160`; native
cells use `maxTurns: 300`. The compiler performs no provider-equivalence
adaptation. The task assignment and producer-side provider constraint continue
to make the runtime cell choice.

## Alternatives considered

- **Keep renderer-owned worker fan-out.** Rejected: the renderer cannot be the
  authoritative publisher and verifier of a complete worker cohort while also
  serving independent static outputs.
- **Compile a task-specific worker artifact.** Rejected: task assignment and
  provider constraints are dispatch-time facts, while worker artifacts are a
  shared matrix-derived cohort.
- **Accept an equivalent configured or cwd `work` plugin.** Rejected: it makes
  the selected cell's identity and verified compiler output ambiguous.
- **Translate provider equivalence during compilation.** Rejected: translation
  is producer-side runtime policy and must not alter the compiled matrix
  topology.

## Consequences

- Claude work publication has one owner, one inventory, and one freshness
  proof; Pi static compilation remains its separate target-scoped surface.
- A source, catalog, or matrix change makes the cohort stale until it is
  compiled, rather than allowing dispatch to infer fresh output from a
  manifest-shaped directory.
- Compatibility callers can continue using `render-plugin-templates`, while
  worker publication and verification retain compiler semantics.
- Wrapped execution remains a runtime wrapper decision with its existing guard
  and delegation contract; compiling a wrapped cell does not make its provider
  route interchangeable with another cell.
