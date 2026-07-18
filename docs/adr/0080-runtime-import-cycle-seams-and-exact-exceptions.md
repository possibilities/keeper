# 80. Runtime import cycle seams and exact exceptions

## Status

Accepted.

## Context

Two production module pairs form runtime strongly connected components: `server-worker` with `rpc-handlers`, and `restore-worker` with `tabs-core`.
These cycles make import-time behavior, singleton ownership, and worker-role
boundaries harder to inspect. Replacing a value import with `import type`, a
lazy import, or a barrel would only hide or defer the coupling when the values
remain part of runtime behavior.

The source graph also contains an independent Agent configuration cycle. A
blanket zero-cycle gate would therefore either fail before it can protect the
new seams or normalize an unreviewed broad exception. A cycle-count ratchet is
also insufficient: the same members can gain different cyclic edges without
changing the count.

## Decision

Runtime cycle removal uses dependency-neutral leaves and explicit composition.

- The server runtime owns the one mutable RPC registry instance. A neutral RPC
  contract leaf owns the shared registrar/lookup interfaces, replay bridge
  shape, and the exact error constructors used for runtime classification.
  `rpc-handlers` installs into the registry supplied by the real server-role
  composition root; importing either module outside that role remains inert.
  Installation stays duplicate-fatal, completes before readiness, and a failed
  partial installation fails the process rather than exposing a partly ready
  server. Existing server-worker exports may re-export the neutral constructors
  when compatibility requires it, but never redeclare them.
- Generation probing moves to a dependency-neutral leaf consumed by
  `restore-worker`, `tabs-core`, and `tmux-boot-seed`. It continues to use the
  canonical generation argv and parser from `exec-backend`. Each caller keeps
  its present distinction among confirmed absence, malformed output,
  spawn failure, and timeout or signal. Rendering and launcher-prefix behavior
  remain owned by `tabs-core` unless a separate neutral extraction is required;
  no implementation is copied to make the graph pass.
- Worker protocols do not change as a side effect of extraction: message
  discriminants and payloads, readiness ordering, error envelopes, cancellation
  and shutdown behavior, exit handling, connection ownership, and main-thread
  import inertness remain observable invariants.

A deterministic source-graph test protects the result.

- It scans production TypeScript under `src/` using the repository's shared,
  comment-aware and type-import-aware dependency parser and resolver. Static
  runtime imports and re-exports are graph edges; mixed type/value imports are
  runtime edges. An unresolved local edge, malformed exception data, or an
  unsupported local dynamic/CommonJS edge fails closed rather than disappearing
  from the graph.
- The removed server/RPC and restore/tabs components have no exception and may
  not recur directly or through an intermediate module.
- Existing accepted cycles live in a committed **cycle exception manifest**.
  Each exception records exact canonical cyclic edges, not only SCC members or
  a count. A changed edge topology fails even when the member set is unchanged.
  An exception that no longer matches a live cycle is stale and fails until an
  explicit reviewed change removes it, so a retired cycle cannot silently
  return behind an old allowance.
- The test proves non-vacuity with known graph anchors and injected direct,
  indirect, same-member-topology, stale-exception, and malformed-input failures.
  As a root correctness test it is discovered by the standard fast gate.

## Consequences

- Shared runtime class identity and one-per-process registry state become
  explicit rather than relying on a cyclic module cache.
- Server startup still fails closed on duplicate or incomplete handler
  installation, while requests cannot observe a ready-but-partial registry.
- Generation identity keeps one producer and one parser; only the probe's module
  ownership changes.
- New runtime cycles fail deterministically. The one current Agent configuration
  cycle remains visible as exact reviewable debt instead of being blessed by a
  broad count or member-list allowance.
- Adding a local import form the graph cannot analyze requires extending the
  analyzer or an explicit architectural decision; it cannot bypass the guard by
  default.
