## Description

**Size:** M
**Files:** test/helpers/depgraph.ts, test/runtime-import-cycles.test.ts, scripts/runtime-cycle-exceptions.json

### Approach

Build a deterministic production-`src/` runtime graph with the existing comment-aware, type-import-aware resolver. Compare canonical cyclic edge topology against a committed cycle exception manifest: the current Agent configuration SCC is exact reviewed debt, while the two removed cycles and every new direct or indirect cycle fail. Fail closed on unresolved local imports, malformed/stale/duplicate exceptions, and unsupported local dynamic/CommonJS edges; mixed type/value imports count as runtime edges.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- test/helpers/depgraph.ts:1-21,144-174,237-271 — shared parser, resolver, and runtime closure walker
- test/daemon-load-surface.test.ts:43-92 — non-vacuous graph anchors and injected violation proof
- test/reconcile-core-depgraph.test.ts:121-170 — ratchet-style structural boundary
- scripts/test-manifest.ts:90-123 — standard root-test discovery
- src/agent/config.ts:34, src/agent/triple.ts:30-36, src/agent/matrix.ts:23 — current SCC whose exact edges seed the exception manifest
- docs/adr/0080-runtime-import-cycle-seams-and-exact-exceptions.md — exact-edge and stale-exception contract

**Optional** (reference as needed):
- scripts/daemon-load-roots.txt:1-20 — complete production source-root precedent

### Risks

- SCC-member or count-only allowances let new edge topology pass unnoticed
- A stale exception can silently authorize a removed cycle's return unless disappearance fails
- Platform-dependent path normalization or ignored resolver errors make local and CI outcomes diverge

### Test notes

Add injected graphs for direct recurrence, indirect recurrence, a new SCC, changed edges with identical members, stale and duplicate exceptions, malformed data, unresolved local imports, mixed imports, and unsupported local dynamic/CommonJS imports. Diagnostics use canonical repo-relative paths.

## Acceptance

- [ ] The standard fast gate discovers a deterministic production-`src/` runtime-cycle test using canonical repo-relative paths
- [ ] The committed exception manifest records exact cyclic edges for only the accepted current Agent SCC; matching is not count- or member-only
- [ ] Direct and indirect recurrence, new cycles, same-member topology changes, stale/duplicate/malformed exceptions, unresolved local imports, and unsupported local runtime import forms all fail closed
- [ ] Known graph anchors and injected violations prove the guard is non-vacuous, and diagnostics are stable across supported environments
- [ ] The focused structural test and named fast gate pass

## Done summary

## Evidence
- Commits: 46db34b3a8770aa6d395168e35a69f1d1ccdc2c9
- Tests: bun test ./test/rpc-handlers.test.ts ./test/server-worker.test.ts ./test/restore-worker.test.ts ./test/tabs.test.ts ./test/runtime-import-cycles.test.ts: pass 244 tests, bun run typecheck: pass, bun run test:gate: pass 9335, 2 skipped