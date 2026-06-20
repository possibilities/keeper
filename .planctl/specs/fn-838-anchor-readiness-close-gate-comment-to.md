## Overview

A load-bearing comment in the armed-mode close-row mutex hard-codes a
cross-file line-number cite (`autopilot-worker.ts:1000-1007`) that rots
silently on any edit to that file, pointing a future reader at the wrong
span. This is a small docs-durability fix: re-anchor the cite to the stable
close-dispatch gate symbol so the mirror invariant stays verifiable.

## Acceptance

- [ ] The readiness close-gate comment no longer cites a line span; it
  names the launcher's close-dispatch gate by symbol/condition.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | readiness.ts:1132-1149/1156-1158/1189-1195 restate a correct present invariant thrice; comment-density style preference, no user impact — auditor agrees leaving it is fine. |
| F2 | kept | .1 | readiness.ts:1135 hard-codes `autopilot-worker.ts:1000-1007`, a cite that rots silently into a wrong-span pointer in another file; re-anchor to the close-dispatch gate symbol. |

## Out of scope

- Removing the triple-restated eligibility-gate comments (F1, culled — this codebase deliberately over-documents ladder-ordering invariants).
- Any behavior change to the readiness ladder or the launcher gate.
