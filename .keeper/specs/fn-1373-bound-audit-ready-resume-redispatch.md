## Overview

The dead-orchestrator AUDIT_READY resume path routes to a fenced work:: owner
redispatch, but that rung bypasses the owner-redispatch attempt bound every other
escalation category enforces: a crash-looping replacement orchestrator re-dispatches
a fresh owner indefinitely (rate-limited by grace and occupancy caps, but
count-unbounded) and NEVER pages the human. This restores the eventual-escalation
safety net for the AUDIT_READY category without disturbing the intended autonomous
single-resume of a healthy handoff.

## Acceptance

- [ ] the AUDIT_READY work rung consults the same owner-redispatch attempt bound as every unblock-routed category
- [ ] after N witnessed replacement-orchestrator deaths past grace, the resume falls through to a page (or a distinct AUDIT_READY-resume-exhausted surface) instead of redispatching forever
- [ ] the intended autonomous resume of a once-dead orchestrator (below the bound) is preserved unchanged
- [ ] a test exercises the repeated replacement-orchestrator death loop and asserts the bound fires and the human is paged

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | route==work hard-sets redispatch_owner while the owner-attempt bound runs only for route==unblock, so a crash-looping AUDIT_READY resume redispatches unboundedly and never pages (audited commit c5967fb0 src/daemon.ts). |
| F2 | culled | — | Duplicated AUDIT_READY block validation across grant-guard.ts and wrapped-guard.ts is forced by mandated hook isolation; note-only refactor clearing no keep bar. |
| F3 | merged-into-F1 | .1 | Test gap for the repeated replacement-orchestrator death path is exactly the test asserting F1's bound-plus-page fix; folded into F1's task. |

## Out of scope

- Consolidating the duplicated AUDIT_READY block validation across the two guards (F2 — culled; justified by mandated hook isolation).
- Any change to the live-orchestrator defer path or to AUDIT_SEVERE routing.
