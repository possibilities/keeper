## Overview

The autopilot's failure telemetry is noise-dominated: the DispatchFailed producer is
unconditional and level-triggered, so one stuck epic re-emitted the same condition 26,344 times
in 27 hours (72% of all failure events ever), the dominant reason string masks the actionable
cause via a check-ordering bug, and all 2,071 reap events carry no reason. Separately, workers
finish code but yield before closing out their task (the identical warm-resume nudge fired on 3
of 4 sampled cells), and the plugin-injection layer is undocumented and unattributable — workers
verifiably inherit the full plugins.yaml including arthack's blanket auto-approve and command
rewrites, contrary to the documented belief. End state: dedup at the producer, honest reasons,
attributable reaps, an enforced close-out gate, and an observed-and-documented plugin layer.
Settled decisions: producer-side change-gate (not a schema-bump watermark) with the restart
re-emit burst accepted; observe-now-gate-later for worker plugin isolation (the gate decision
belongs to the dissolution study).

## Quick commands

- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT COUNT(*) FROM events WHERE type='DispatchFailed' AND ts > <deploy>"` — storm gone (single-digit per stuck condition)
- `keeper query jobs --json` after a reap — reason field populated

## Acceptance

- [ ] A persistently-stuck worktree condition emits one DispatchFailed on appearance (plus bounded still-stuck watermarks), not one per cycle; clear-on-resolution stays immediate
- [ ] A checkout that is both dirty and off-branch reports the dirty state (the actionable cause), never only not-on-default
- [ ] Killed and DispatchExpired events carry a reason; the fold defaults safely for historical events and refold-equivalence stays green
- [ ] A worker yielding with undischarged session files is gated (nudged automatically or blocked) at the machine layer, not by per-call hook tips
- [ ] The plugin composition per launch channel is documented as reality (workers inherit full plugins.yaml) and arthack hook actions are attributable in observed data

## Early proof point

Task that proves the approach: `.1` (change-gate dedup). If the in-memory gate proves
insufficient (e.g. unacceptable restart bursts in practice), escalate to the SQL emit-once
watermark pattern (merge_escalated_at precedent) with its schema-bump costs.

## References

- autopilot-worker.ts:4332-4356, 4104-4109 — unconditional emit sites
- autopilot-worker.ts:4116-4131 — lastWorktreeStatusKey change-gate precedent (LaneMerged same)
- worktree-git.ts:539-558 — mergeReadiness ordering bug (off-branch checked before dirty)
- daemon.ts:4010-4046 (Killed), 5301-5340 (DispatchExpired) — reason-less reap mints
- src/dispatch-failure-key.ts — typed reason vocabulary; prefixes must stay collision-free
- agent/main.ts:2194-2222 + exec-backend.ts:874-876 — worker plugin inheritance reality
- Review evidence: fn-7 epic 26,344 events/27h peak 5,429/hr; 19,789 not-on-default rows masking dirty-checkout

## Docs gaps

- **CLAUDE.md (root)**: the autopilot/worktree paragraph needs line-surgical edits where dedup changes row timing; lint-gated, minimal delta
- **CLAUDE.md (root)**: the worker-launch sentence corrected to reality (workers inherit plugins.yaml; per-cell --plugin-dir is additive)
- **plugins/keeper/skills/autopilot/SKILL.md**: dispatch_failure block-kind enumeration if kinds change

## Best practices

- **Dedup asymmetry:** collapse repeated same-condition emissions aggressively; surface new conditions and clears immediately
- **for-clause + repeat_interval:** escalate to sticky visibility only after N persistent cycles; re-announce a still-firing condition on a bounded watermark, not per cycle
- **Inhibit symptoms under a root cause:** a root sticky row suppresses same-epic symptom re-emits
