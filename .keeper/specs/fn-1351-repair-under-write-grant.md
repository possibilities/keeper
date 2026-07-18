## Overview

SHARED_BASE_BROKEN stops dispatching a top-level repair session: the daemon elects exactly one blocked owner per (repo, fingerprint) and issues the single trunk write grant; that owner's work session runs plan:repairer in-session under the grant while every other affected owner parks visibly. Trunk red with no live consumer mints a real maintenance plan task through the plan CLI, run by an ordinary work dispatch — repair never returns as a top-level session.

## Quick commands

- `bun test test/daemon.test.ts` — repair sweep election + parking suites green
- `keeper prompt render-plugin-templates --project-root plugins/plan --check` — work skill render drift-free

## Acceptance

- [ ] At most one write grant exists per (repo, fingerprint) at any time, counted by grants, and the granted owner's session lands the trunk fix in-session
- [ ] Ungranted affected owners park visibly and unblock on the objective baseline-green clear
- [ ] Trunk red with no blocked consumer produces exactly one open maintenance task, dispatched as ordinary work
- [ ] No repair session dispatches from this epic on

## Early proof point

Task that proves the approach: task 1. If in-session repair proves unable to satisfy the reproduce-at-HEAD gate from a lane-rooted session, fall back to granting only sessions whose cwd is the shared checkout and surface the constraint.

## References

- docs/adr/0089-in-session-escalation-subagents.md — single-writer-by-grant decision and maintenance-task fallback
- The trunk-repair escalation record (docs/adr, trunk-repair 0017) — the N-writers objection the grant model preserves
- docs/adr/0055/0078/0085 — claim lifecycle the grant follows (election, release, orphan expiry)

## Docs gaps

- **CLAUDE.md autopilot section**: repair-session wording goes stale here; rewritten by the retirement epic

## Best practices

- **Count grants, not sessions:** the single-writer proof is the grant count, never a jobs-row census
- **Fence the ex-leader:** a stale repairer's writes die at the token check, not at election
- **Idempotent minting:** one open maintenance task per (repo, fingerprint), re-probed before mint
