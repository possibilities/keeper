## Overview

Finished worker/closer sessions do not release their resources: the launch wrapper's trailing interactive shell (or lingering launcher process) keeps the tmux pane alive after the claude session ends, so pane_current_command shows a live process and the slot machinery treats the slot as occupied — a dead closer wedged an epic's close re-dispatch until an operator killed the pane by hand, another closer idled 10h53m post-turn, stuck-sentinel ack-rows accumulate (and outlive their pruned jobs), and done-task verdicts flap when owning-session liveness flaps. This epic moves slot and verdict authority onto the job lifecycle state the daemon already proves (exit-watcher), reconciles orphaned ack-rows, and stabilizes the done-and-idle verdict — while preserving the deliberate pane-persistence UX (`keeper tabs restore` inspection).

## Quick commands

- `bun test test/autopilot-worker.test.ts test/exec-backend.test.ts test/exit-watcher.test.ts` — the three touched suites
- `keeper query dispatch_failures --json` — post-deploy: no slot-occupied rows pointing at dead sessions, no sentinel rows pointing at pruned jobs

## Acceptance

- [ ] A pane whose session the daemon has proven dead is reclaimable: it no longer blocks a re-dispatch of the same slot
- [ ] Stuck-sentinel ack-rows never point at a job absent from the projection
- [ ] A done task's verdict is stable while its owning worker stays terminally stopped, regardless of sibling-session liveness churn

## Early proof point

Task that proves the approach: `.1` (slot authority from job lifecycle). If consulting job state inside the occupancy gate proves too coupled: fall back to tmux-native pane_dead keying with remain-on-exit plus an explicit reap step — the acceptance contract is unchanged.

## References

- docs/adr/0013-jobs-lifecycle-stamp-and-stuck-sentinel.md — jobs lifecycle + sentinel discipline this epic amends
- CONTEXT.md: Phantom-working, Reaper — the flap vocabulary; slot-occupancy gate and ack-row lifecycle are candidates for new glossary entries
- Incident evidence: close job 3cc1bce0 state=stopped with pane %273 alive running the launcher wrapper (slot-occupied sticky wedged close::fn-1195 re-dispatch until manual pane kill); closer f6aee7cb idle 10h53m holding pane %207; seven stale-working sentinel rows, five pointing at already-pruned jobs; task fn-1193.6's verdict flapped completed↔running while its worker job bca266d8 sat stopped with zero discharge counters
- macOS constraint: no subreaper/pdeathsig — process-group teardown (setsid/killpg TERM→KILL) or authoritative-state keying, never orphan-reparent assumptions [practice-scout]

## Docs gaps

- **docs/adr/0013**: amend with the slot-authority and ack-row reconciliation decisions once landed
- **plugins/keeper/skills/watch/SKILL.md**: the slot-occupied "visibility only" framing and manual-verify guidance around stuck closes — reconcile with the new reclaim behavior
- **CONTEXT.md**: Phantom-working/Reaper entries — sharpen or add slot-occupancy-gate vocabulary if the fix changes when a row counts as phantom

## Best practices

- **Never key liveness solely on pane_current_command** — it reports the foreground process, which a lingering wrapper masks and short-lived subprocesses flap [practice-scout]
- **Batched list-panes probing** (one call, whole server) — never per-pane spawns [practice-scout]
- **Pane metadata is attacker-influenced** — never shell-interpolate a pane command name into a kill invocation; one bounded JSON line per record [practice-scout]
