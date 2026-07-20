## Overview

Add direct test coverage for the operator dispatch-clear liveness fence's
main-side wiring. The pure `decideDispatchClearLiveness` decision is well
tested and the typed refusal replies are exercised via a stub bridge, but the
`probeLiveness` closure that maps `dispatch_claims` + `jobs` rows to a
liveness verdict — the exact seam whose null-handling regression would clear
a live claim — is reached only indirectly. This is a test-only hardening of
the fence the epic shipped, no behavior change.

## Acceptance

- [ ] The `probeLiveness` job-lookup arms are directly asserted: null/empty session_id, absent job row, and a partial job row (null pid or null/empty start_time) each yield `inconclusive` (refuse-live).
- [ ] The main-side `refused_live` / `refused_identity` / `cleared` reply construction is exercised against the real handler path (or an extracted pure seam), not only the injected stub.
- [ ] New tests run within the no-real-daemon discipline (pure seam or `freshMemDb` with seeded `dispatch_claims`/`jobs`), behind a named `*.test.ts` gate.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | probeLiveness closure (daemon.ts:10387-10405) inconclusive arms reached only indirectly; a silent null-handling regression would clear a live claim and escape the gates. |
| F2 | culled | — | surface.ts:842 DRY nit — a 4th terminal status throws a RangeError loudly on first bind, not a silent mismatch; caught on next touch. |
| F3 | culled | — | emitBirthParkBackstop (daemon.ts:6964) conflates the two parks under one counter, but detail.status preserves the true status per record; rare-path metric polish below the bar. |

## Out of scope

- The DRY refactor of the terminal-status placeholder list (F2, culled).
- Splitting the birth-ingest-poison counter name per parked status (F3, culled).
- Any behavior change to the fence itself — this is coverage only.
