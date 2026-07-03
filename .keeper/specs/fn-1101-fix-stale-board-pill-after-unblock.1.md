## Description

**Size:** S
**Files:** (repro decides: plan-worker emission, the watch delta stream, or the reconnect snapshot path)

### Approach

Repro first, in the fake/pure tier where possible: does the plan-worker fold emit a
projection delta for an unblock (blocked→todo runtime-overlay flip), and does the coarse
board delta stream carry it to an already-subscribed consumer? Then the reconnect axis: a
consumer that reconnects after a daemon bounce — does its resubscribe snapshot+delta
handoff cover mutations that landed while disconnected? Fix whichever leg drops it: emit
the missing delta, or make the reconnect repaint authoritative (full row refresh on
resubscribe). Keep the fix on the serve/producer side — never a TUI-side poll.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/plan-worker.ts — the fold/emit path for runtime-overlay changes (does unblock reach db-poll emission?)
- the board watch delta stream (server-worker subscribe serve path) — what keys a row-delta emit
- test/ — existing watch-delta tests (the verdict-flap debounce work is the nearest precedent surface)

### Risks

- The verdict-flap debounce must not swallow the unblock transition as noise — verify the
  debounce window treats a runtime-status flip as signal.

## Acceptance

- [ ] A reproducing test (pure tier) demonstrates the dropped unblock delta, then passes with the fix
- [ ] An already-subscribed watch consumer reflects an unblock without restart, including across a reconnect
- [ ] bun test green

## Done summary

## Evidence
