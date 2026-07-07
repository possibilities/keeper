## Overview

Keeper's human-facing viewers paint whatever the subscribe socket serves, including
mid-re-fold partial state — a rebooting daemon makes every TUI churn through
historical fold states. This epic gates live rendering on the boot-status header the
server already stamps: while the daemon is down or catching up (boot drain,
schema-bump re-fold, git seed), viewers show only a loading indicator with real
re-fold progress, and resume painting the moment the daemon reports ready. Client-side
only — the serve-during-catch-up contract and every headless consumer stay untouched.
The decision record is docs/adr/0019-tui-readiness-gate-over-boot-status.md.

## Quick commands

- bun test test/readiness-client.test.ts test/view-shell.test.ts test/refold-progress.test.ts test/snapshot.test.ts test/frames-emitter.test.ts
- Operator post-land smoke: restart keeperd under a running `keeper board` — expect the loading indicator with re-fold %, zero churn, data resuming when ready.

## Acceptance

- [ ] A viewer launched while the daemon is down or catching up renders only the loading indicator (re-fold % / git-seed wait / catching-up line) until the daemon reports ready
- [ ] An already-painted viewer whose daemon restarts flips to the loading indicator (immediately on a catch-up-reporting result; after a short grace on an unreachable socket) and never paints intermediate fold states
- [ ] keeper status, keeper await, and the autopilot CLI keep receiving data during catch-up — no headless behavior change
- [ ] The snapshot keeper-meta trailer and frames records carry catching_up with both schema constants bumped; frames mode emits exactly one loading record during catch-up
- [ ] The displayed re-fold percentage never regresses within a run

## Early proof point

Task that proves the approach: ordinal 1 (the subscribe-client latch + backstop). If
the latch cannot be shown to clear reliably after boot completes, fall back to an
unconditional refetch-while-gated loop — same shape, no headerless-result clear.

## References

- docs/adr/0019-tui-readiness-gate-over-boot-status.md — the decision this epic implements
- docs/adr/0012-agent-frame-stream-wire-contract.md — the frames envelope contract the stamping extends
- src/protocol.ts BootStatus doc comment — the wire header consumed by the gate
- `fn-1175` (overlap) — its todo tasks rewrite src/readiness-client.ts (snapshot projection regions) and cli/board.ts (subscribeReadiness opts); dep wired so lanes fork after it lands
- `fn-1172` (overlap) — landed-move caution: its done work removed the epics_selection_review projection across readiness-client/board; re-read those regions and clone the surviving includeDispatchFailures opt-in pattern

## Docs gaps

- **CONTEXT.md**: add the "Catching up" glossary entry (rides task 3 — the entry's region was mid-merge-conflict at plan time, so it lands via that task's lane instead of a plan-time commit)

## Best practices

- **Hold, don't blank, on disconnect:** a short grace with a reconnecting pill before flipping to loading keeps sub-second daemon bounces flicker-free [oneuptime websocket-reconnection]
- **Determinate progress for long waits:** show % plus raw counts and never let the bar regress — clamp monotonic, fall back to counts on an unstable denominator [nngroup progress-indicators]
- **A text label rides every animated state** ("re-folding 38%", "reconnecting…") — animation is never the only signal [primer loading patterns]
- **Bound the backstop to the catch-up window:** an idle-state poll is churn; disarm the moment the latch clears [lazygit discussion 5065]
- **Only the indicator region repaints while gated** — no full-screen clears per tick [Textualize/rich 2139]
