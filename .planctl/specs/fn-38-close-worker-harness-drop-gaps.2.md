## Description

**Size:** M
**Target repo:** /Users/mike/code/keeper
**Files:** src/exit-watcher.ts, src/reducer.ts, src/readiness.ts, src/autopilot-worker.ts (+ tests under test/)

Closes F4 from task .3's silent-death census. SILENT_STREAM_CUT is the
dominant actionable class (50/82 deaths; 0/50 correlate with any api_error
within +/-90s): the harness terminates a worker subagent turn between a
tool_result and the model's next API response, emitting a `SubagentStop`
with NO `Killed` / `ApiError` / `RateLimited` / `SessionEnd`. keeper sees the
stop but mints no drop signal, so recovery waits on the slow (~60s) dead-pid
reprobe (or never fires). Add a keeper-side detector that recognizes the
signature and drives faster auto-resume — analogous to the exit-watcher's
existing synthetic `Killed` minting.

### Approach

The signature: a worker turn whose last assistant message has
`stop_reason` of `tool_use` or `null` (per Anthropic streaming docs, `null`
= interrupted stream, never a real end_turn) and no terminal text, followed
by `SubagentStop`, with no terminal error event for that job within the
correlation window. Mint a synthetic drop signal (mirror the
`reprobeLoop` → synthetic `Killed` path in src/exit-watcher.ts) and route it
into the autopilot/readiness resume surface so the dropped task re-dispatches
without waiting on the dead-pid reprobe. Respect the event-sourcing
invariants: the signal must round-trip as a synthetic event so a re-fold
reproduces it byte-identically, the fold must never read wall-clock, and the
detector MUST NOT false-positive on a normal `end_turn` (terminal text
present) or a legitimately completed turn.

### Investigation targets

**Required** (read before coding):
- src/exit-watcher.ts (reprobeLoop ~:321, synthetic-Killed mint path ~:630) — the analogous detector to mirror
- src/reducer.ts (SubagentStop fold ~:3888; SessionEnd/Killed sweep of running rows ~:3751-3802) — where stop_reason/terminal-text state is foldable
- src/readiness.ts (computeReadiness) — how a re-readied task drives autopilot dispatch
- CLAUDE.md "Event-sourcing invariants" + "Autopilot" sections — the re-fold-determinism and synthetic-event rules this must honor

**Optional** (reference as needed):
- task .3 evidence sids: 492f5307 (subagent_stop@+3s then resume@+21s), cfcbc8ec, ea343ed2 — representative SILENT_STREAM_CUT signatures for a fixture

### Risks

- False-positiving on normal end_turn yields or completed turns would spuriously re-dispatch live/done work — the terminal-text + no-error guard is load-bearing.
- Re-fold determinism: the synthetic signal must derive only from event data (the stop event's own fields + prior folded turn state), never process liveness or wall-clock.

### Test notes

`bun run test:full` is mandatory — this touches reducer / exit-watcher / readiness paths the fast tier does not cover. Build fixtures from the task .3 evidence signatures; assert no false-positive on a normal end_turn turn.

## Acceptance

- [ ] A keeper-side detector mints a synthetic drop signal for the SILENT_STREAM_CUT signature (SubagentStop after stop_reason=tool_use/null, no terminal text, no api_error/killed/session_end in window) and drives auto-resume faster than the dead-pid reprobe.
- [ ] The signal round-trips as a synthetic event; a from-scratch re-fold reproduces the rows byte-identically (re-fold determinism preserved).
- [ ] No false-positive on a normal end_turn (terminal text present) or a completed turn, proven by a fixture from the task .3 evidence and a negative control.
- [ ] `bun run test:full` green; work committed via `keeper commit-work`.

## Done summary

## Evidence
