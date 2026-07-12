## Description

**Size:** S
**Files:** src/agent/transcript-watch.ts, src/agent/pair-subcommands.ts, test/

### Approach

A resumed pi session's transcript file contains the full copied prior
conversation re-stamped with resume-time timestamps, so timestamp-window
filtering cannot distinguish copied history from the new turn. Anchor the
resumed-capture stop scan past the copied history structurally instead:
identify the resume boundary (this turn's own user prompt entry — the last
user entry at file appearance, or a count-prior-stops-at-launch watermark
and wait for a strictly newer one) and accept only a stop after it. The
`isResume` marker already threads through ResolvedHandle into
transcript-watch, so the change is pi-branch-local; claude forks a fresh
child session on resume and codex/hermes resolve differently — their scans
must stay byte-identical. Also verify `findLastMessage` (used by the
timed-out partial path), which scans the whole file by design, does not
reintroduce the stale answer on the resumed-timeout path.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/transcript-watch.ts findTranscriptStop (~:377) — the `eventMs < startedAtMs - START_SLOP_MS` skip that re-stamped copies defeat; pi/codex share the plain first-stop scan
- src/agent/transcript-watch.ts findPiTranscriptInFiles (~:354) — pinned-id resolution finds the resumed file
- src/agent/pair-subcommands.ts ResolvedHandle.isResume — the resume marker already threaded for codex's created-at floor
- src/agent/run-capture.ts captureFromHandle — where the stale stop became a `completed` envelope
- Observed repro (this session): resumed pi partner returned the byte-identical prior answer at 28.5s while the new turn ran on for minutes; new file `2026-07-11T15-00-45-869Z_935e4d92-*.jsonl` carried copied entries stamped 15:00:45+

## Acceptance

- [ ] A synthetic resumed pi transcript (copied history with fresh timestamps + a new
      in-flight turn) does NOT capture until the new turn's stop lands, and then captures
      the NEW answer — pinned by a regression test that fails on the current code.
- [ ] A fresh (non-resume) pi capture and claude/codex/hermes capture behavior are
      byte-identical to today (existing suites stay green).

## Done summary
Anchor resumed-pi capture on a structural stop-count watermark: waitForTranscriptStop samples the prior-stop count when the wait begins and returns only a strictly-newer stop, so a re-stamped copied prior answer is never captured; findLastMessage cuts the timed-out partial read to this turn's own prompt. Fresh pi and claude/codex/hermes byte-unchanged.
## Evidence
