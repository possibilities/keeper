## Overview

A content conflict found while recover pass-2 merges a done epic's base branch into the
default branch currently mints an auto-clear-scoped `worktree-recover-conflict` row whose
clear predicate is absence-of-report — one silently-skipped cycle converts a permanent
conflict into a clean-looking board, and the planner-escalation + merge-resolver sweeps
never engage (they key on the finalize-style `close::<epic>` `worktree-merge-conflict`
sticky). End state: recover-time content conflicts mint that same durable sticky (resolver
dispatched, planner notified, only `retry_dispatch` drops it); transient recover degrades
keep their auto-clearing per-(epic,repo) keys; recover-row clears require a POSITIVE
per-(epic,repo) observation of resolution; and the epic-done/presence probes become
tri-state so an inconclusive read defers (retains rows, preserves lanes) instead of
silently skipping or sweeping.

## Quick commands

- `bun test test/autopilot-worker.test.ts test/daemon.test.ts test/dispatch-failure-key.test.ts` — the recover/clear/escalation surfaces.
- `bun scripts/lint-claude-md.ts` — the CLAUDE.md reclassification stays inside the size gate.
- `rg -a -n "worktree-merge-conflict" src/autopilot-worker.ts src/dispatch-failure-key.ts` — the recover conflict arm now mints the escalation token.

## Acceptance

- [ ] A recover pass-2 content conflict lands as a `close::<epic>` DispatchFailed with a `worktree-merge-conflict` leading reason, is selected by the resolver-dispatch and merge-escalation sweeps, survives every auto-clear, and drops only via `retry_dispatch`.
- [ ] Transient recover degrades (dirty, mid-merge, locks, timeouts, would-clobber, off-branch, non-ff, push failures) keep their per-(epic,repo) `worktree-recover-*` keys and level-clear behavior.
- [ ] An open recover row clears only on a positive same-cycle observation (merge succeeded, base is ancestor of default, or the epic reads authoritatively absent); a cycle that produces no report for it retains it.
- [ ] The incident shape is pinned: one epic's probe inconclusive while a sibling's conflict is re-reported in the same sweep → the first epic's rows are retained and its base is not merge-attempted.
- [ ] An epic with a live merge-resolver is not merge-attempted by pass-2.
- [ ] Pass-3 lane teardown preserves lanes on an inconclusive presence probe.
- [ ] CLAUDE.md's autopilot paragraph states the new classification within the existing size gate; `bun run test:full` green.

## Early proof point

Task that proves the approach: `.1`. If the separate-escalations return contract cannot be
made to route cleanly through `routeDispatchFailure` (finalize-ID → recover-reason →
merge-escalation precedence) without disturbing the finalize flow, stop and re-plan the
keying before touching the clear predicate.

## References

- Incident: a done epic's base conflict was detected by recover pass-2, then its sticky row was DispatchCleared in a cycle whose sweep produced no report for that epic (a sibling epic's conflict WAS re-reported the same cycle), and the conflict went unreported for 17 hours within one daemon run until a manual merge. The projection row was present and done throughout; the pk-lookup read path provably bypasses scope/recency floors — the swallow-to-`false` of a non-result frame in the done-probe plus the absence-based clear predicate are the two defects.
- The finalize-side level-clear is the correct pattern to mirror: it clears only ids present in a positive `finalizedClean` observation set. Only the recover clear is absence-based.
- Routing precedence (`routeDispatchFailure`): finalize-ID-prefix → `worktree-recover` reason-prefix → `worktree-merge-conflict` token → close-plain. The retargeted conflict must carry the escalation token on the bare `close::<epic>` id — the id the resolver brief and human escalation hardcode in `keeper autopilot retry close::<epic>`.
- Multi-repo note: bare `close::<epic>` keying for content conflicts matches finalize's existing close-sink behavior (same-key UPSERT convergence is the dedup); per-repo masking of two simultaneous same-epic conflicts is the accepted status quo finalize already has.
- Out-of-band base deletion (human `git branch -D` on a conflicted base) deliberately does NOT auto-clear the sticky — `retry_dispatch` is the operator acknowledgment for abandoning the merge; ordinary teardown never strands rows (the ancestor observation clears them the cycle before pass-3 prunes).
- A sustained inconclusive done-probe with no prior open row defers silently — accepted for a transient local read error; a persistent one surfaces through the daemon's existing distress machinery, not this surface.

## Docs gaps

- **CLAUDE.md**: rewrite the autopilot paragraph's recover auto-clear clauses to the new classification (content conflict → durable `close::<epic>` sticky; transient degrades → auto-clear prefix; clears → positive-evidence only). Net-neutral-or-smaller; the lint gate is the tripwire.
- **CONTEXT.md**: add a one-line "Recover pass" entry to the Worktree-and-merge glossary section (siblings Lane / Merge-gate / Resolver / Fan-in already exist).

## Best practices

- **Three-valued condition state:** resolved / still-failing / unknown — absence of observation is never resolution [K8s status-condition conventions].
- **Clearing is itself a dangerous action:** the clear predicate carries a higher evidence bar than the mint; bias toward retention [SCADA latched alarms, fail-safe automation].
- **Terminal vs transient taxonomy:** content conflicts are terminal (escalate, operator-ack to drop); locks/dirt are transient (level-clear) [retryable-vs-terminal error taxonomies].
- **Producer-side bounded observation:** the positive-evidence set is probed once per cycle by the producer and consumed as plain data — never re-derived in a fold [repo invariant, mirrors deferredEpicIds].
