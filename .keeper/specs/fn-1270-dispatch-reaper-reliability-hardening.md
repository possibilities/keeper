## Overview

Four reliability defects from the 2026-07-12/13 supervised drain, resolved per ADR 0052
(amends ADR 0031): idle sessions holding dispatch slots get reclaimed; the stored per-root
cap is honored under worktree mode; degraded working-set reads defer instead of resolving;
and a done-but-unstamped epic gets a recovery-only direct close stamp instead of an
infinite closer cycle. End state: the board drains without an operator hand-reaping
zombies or force-closing epics.

## Quick commands

- `bun test test/autopilot-worker.test.ts test/readiness.test.ts test/autoclose-worker.test.ts` — the reaper/allocator/reap-skip surfaces green
- `keeper autopilot show` — stored max_concurrent_per_root visible; effective cap honors it while worktree mode is on

## Acceptance

- [ ] A stopped-with-idle-backend keeper session past the grace no longer starves a wanted root slot (reclaimed automatically; `working` never touched)
- [ ] With worktree mode ON and max_concurrent_per_root=2, two distinct lanes of one root run concurrently; worktree OFF floors to one
- [ ] An error-frame readiness read defers the tick (no reap, no dispatch); a genuinely empty board still dispatches
- [ ] An all-tasks-done epic whose lane is already merged, with a prior closer that finished without stamping, closes via the marked recovery stamp instead of cycling closers

## Early proof point

Task that proves the approach: ordinal 1 (degraded-read deferral) — it is the smallest slice
and exercises the shared input seam every later task builds on. If it fails: re-scope the
signalling to a reap-consumers-only flag and keep the dispatch path unchanged.

## References

- docs/adr/0052-idle-slot-reclaim-and-per-root-cap-honoring.md (the decision record for all four directions; amends 0031)
- docs/adr/0031-finalize-defers-on-occupying-closer.md (the deferral this work resolves)
- CONTEXT.md entries: Per-root cap, Phantom-working, Reaper, Escalation dispatch (the glossary is the spec — code catches up to it)

## Docs gaps

- **CLAUDE.md**: verify no autopilot guardrail line narrates the old cap-1/idle-counts-live behavior after this lands; prune/replace in place only if one does (lint-claude-md must stay green)

## Best practices

- **unknown is never dead:** an errored/empty-on-error liveness read must skip the sweep, not mass-reap [k8s/encore.dev postmortems]
- **reap by pane/PID identity re-verified at signal time:** TOCTOU/PID-reuse (CWE-367); repo owns src/proc-starttime.ts
- **blast cap + release-slot-then-kill two-stage:** cap reaps per sweep; never reap the readiness axis
- **1→N un-serializes hidden contention:** ramp the cap operationally in steps; watch shared-checkout git ops and SQLite writer tail latency
