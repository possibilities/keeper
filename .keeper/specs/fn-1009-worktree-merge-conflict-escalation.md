## Overview

When keeper's worktree fan-in hits a content conflict at epic close, it mints a
STICKY `worktree-merge-conflict` `dispatch_failures` row that autopilot
deliberately never auto-retries — so the board silently stalls until an operator
notices. This epic adds a daemon-side escalation sweep that notifies
`planner@<epic>` over the Agent Bus exactly once with a prescriptive resolve +
unstick brief, mirroring the existing block-escalation flow. The board-visibility
pill already shipped (commit d706114c); this is the notification half. End state:
a stuck close surfaces to the planner within ~one sweep interval, carrying the
exact `git merge --no-ff → resolve → test → retry_dispatch` recipe.

## Quick commands

- `bun test test/daemon.test.ts -t "merge escalation"` — the sweep / gate / body harness.
- `bun test test/refold-equivalence.test.ts test/schema-version.test.ts` — the determinism + schema-whitelist guards.

## Acceptance

- [ ] A sticky `worktree-merge-conflict` close failure escalates to `planner@<epic>` over the bus exactly once, within one sweep interval.
- [ ] The escalation NOTIFIES only — it never clears the sticky row; only `retry_dispatch` clears it.
- [ ] The excluded reasons (`worktree-finalize-non-fast-forward`, lock/local-timeout, `worktree-recover*`) never escalate.
- [ ] Re-fold byte-equivalence and the schema-version whitelist stay green.

## Early proof point

Task that proves the approach: `.1` (the event + column + fold). If re-fold
byte-equivalence can't hold for the new event folded onto `dispatch_failures`, the
whole marker-on-the-row approach is wrong and we reconsider a parallel latch table
BEFORE building the sweep.

## References

- Mirrors the daemon block-escalation flow: `runBlockEscalationSweep` / `notifyPlannerOfBlock` / the `block_escalations` pending→requested→attempted latch (`src/daemon.ts`).
- Board-visibility `[failed:<kind>]` close-row pill shipped at commit d706114c.
- Overlaps surfaced by epic-scout, wired as serializing deps: fn-1005 (both edit `src/daemon.ts`), fn-1007 (both edit `src/reducer.ts`).

## Docs gaps

- **README.md `## Architecture`**: add a merge-escalation sweep paragraph, sibling to the block-escalation producer (~3112-3143), using the same two-event-latch / fail-open / `planner@<epic>` framing.
- **README.md**: name the `worktree-merge-conflict` reason key in the finalize content-conflict paragraph (~3272-3285); document the new `merge_escalated_at` column in the `dispatch_failures` table description (~2667-2687); add an `As of schema vN (fn-xxx)` history entry; note in the autopilot retry section (~1128-1136) that `worktree-merge-conflict` closes need conflict resolution BEFORE `retry` re-arms dispatch.
- **CLAUDE.md worktree guardrail (line 116)**: extend the existing sentence — the merge-escalation gate is a column on `dispatch_failures` (never a sibling latch table) and the sweep is read-only wrt the sticky row (only `retry_dispatch` clears it). Single line; size-gated by `lint-claude-md.ts`.

## Best practices

- **Git merge-commit mechanics:** `git merge --no-ff <source>` makes a two-parent commit so the source becomes an ancestor and a later fan-in `git merge` no-ops; `--squash` / rebase produce a single-parent commit that re-conflicts on retry — the #1 worktree-integration mistake. [git-merge docs]
- **Idempotent dispatch:** keep "failure exists" (the sticky row) distinct from "escalation sent" (the marker); a `send_failed` / undelivered outcome stays non-terminal (re-sweepable), only delivered / `queued_for_wake` is terminal. [transactional-outbox pattern]
- **LLM conflict resolution:** require a dual-intent resolution ("merge both sides, don't pick one"); passing tests are necessary-not-sufficient; escalate semantically-dense conflicts (state machines / schema / security / transaction boundaries) to a human — a confident-but-wrong merge is worse than a failed one. [GMerge ISSTA22]
