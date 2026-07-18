## Overview

Remove the server-worker↔rpc-handlers and restore-worker↔tabs-core runtime cycles without hiding them behind lazy imports or duplicating behavior. Dependency-neutral leaves make ownership explicit, while an exact-edge source-graph guard prevents either cycle or any new runtime cycle from returning and keeps the one current Agent configuration SCC visible as reviewed debt.

## Quick commands

- bun test ./test/rpc-handlers.test.ts ./test/server-worker.test.ts ./test/restore-worker.test.ts ./test/tabs.test.ts ./test/runtime-import-cycles.test.ts
- bun run typecheck

## Acceptance

- [ ] The server/RPC runtime graph is acyclic while registry ownership, error identity, readiness, replay, and role-scoped installation remain unchanged
- [ ] The restore/tabs runtime graph is acyclic while all three generation-probe consumers preserve their distinct failure contracts and canonical Generation identity
- [ ] A standard-gate structural test fails closed on direct, indirect, topology-changed, stale-exception, malformed, and unresolved runtime-cycle evidence
- [ ] The only accepted current runtime cycle is represented by exact canonical cyclic edges in a committed cycle exception manifest

## Early proof point

Task that proves the approach: task 1. If constructor identity or registry composition cannot be preserved by the neutral contract leaf, retain server ownership and narrow the leaf to shared constructors plus injected registrar/lookup interfaces.

## References

- docs/adr/0080-runtime-import-cycle-seams-and-exact-exceptions.md — binding ownership and graph-guard decision
- docs/adr/0013-canonical-generation-identity.md — one canonical Generation producer/parser contract
- docs/adr/0029-daemon-load-surface-fingerprint.md — deterministic transitive source-boundary precedent

## Best practices

- **Neutral leaves, explicit composition:** shared contracts carry no concrete singleton state or import-time behavior
- **Runtime graph, not TypeScript reference graph:** type-only edges are erased; mixed imports remain runtime edges
- **Exact reviewed exceptions:** edge topology and stale entries fail rather than hiding behind a cycle count
