## Overview

The merge-time schema-renumber tool re-pins SCHEMA_FINGERPRINT from the
process-start-imported src/db module rather than from the ladder it just
renumbered, so every real renumber pins a stale version on both the fingerprint
prefix and its digest. This defeats the tool's core automation: the resolver's
exit-0 "mechanically clear" commit fails its own schema-version test gate. This
follow-up corrects the re-pin to derive from the renumbered ladder and adds the
composed regression test that would have caught it.

## Acceptance

- [ ] A real renumber pins a SCHEMA_FINGERPRINT that matches a from-scratch
      recompute of the renumbered ladder's tail (correct prefix and digest).
- [ ] A composed renumber -> re-pin test exercises a synthetic colliding lane
      end-to-end and asserts fingerprint consistency; it fails against the
      current re-pin and passes after the fix.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Re-pin reads the process-start src/db module (pre-shift SCHEMA_VERSION), not the renumbered ladder, pinning a stale v<N> that fails the schema-version gate on every real renumber. |
| F4 | merged-into-F1 | .1 | F4 (no composed renumber->re-pin test) shares F1's root cause and fix commit; the F1 fix lands the regression test recomputing the renumbered tail. |
| F2 | culled | — | Speculative toBe(N) over-rewrite is narrow to two schema test files and fails loud on any mis-rewrite; below the keep bar. |
| F3 | culled | — | Silent frozenset/test-path no-op already fails loud at the derivability gate; a non-fatal notice is a diagnostic nicety, not a fix. |

## Out of scope

- Tightening rewriteTestAssertions' toBe(N) anchor (F2, culled — fails loud in the gate).
- Emitting a non-fatal notice on rewriteApiPyFrozenset/TEST_PATHS misses (F3, culled — already caught by the derivability test).
