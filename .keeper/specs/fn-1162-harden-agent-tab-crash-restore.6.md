## Description

**Size:** S
**Files:** src/reducer.ts, test/reducer-lifecycle.test.ts

### Approach

A failed resume attempt can no longer poison the jobs projection. In the SessionStart fold arm, a non-null `transcript_path` is no longer overwritten by a bare SessionStart; it updates only from events that prove a live session — activity events (UserPromptSubmit / PostToolUse / Stop) that already carry transcript_path — while the initial row INSERT may still seed it. A failed resume emits SessionStart (and SessionEnd) without activity, so its predicted-but-never-created path can never clobber the last good one. Pure data guard: no filesystem, wall-clock, env, or liveness reads inside the fold; malformed events keep folding safely. `cwd` remains set-once at insert — state that invariant in the fold's forward-facing comment. This refines the positive-evidence philosophy of the session-adoption ADR without touching its adoption predicate.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/reducer.ts:7930-8070 — the SessionStart insert/upsert arm (jobId = event.session_id; the DO-UPDATE SET list)
- src/reducer.ts:350-358 — extractTranscriptPath
- test/reducer-lifecycle.test.ts — fold-sequence test patterns to extend

**Optional** (reference as needed):
- docs/adr/0007-positive-evidence-session-adoption.md — the philosophy this guard refines
- src/reducer.ts:8200-8240 — the sparse fork-seed arm that also binds cwd/transcript columns

### Risks

- Activity arms must actually carry transcript_path in their payloads — verify per event type before gating; an activity event without the field must not null the column.
- Re-fold determinism: the guard must produce identical projections on replay.

### Test notes

Sequences: seed → failed-resume (SessionStart+SessionEnd) ⇒ path intact; seed → real resume (SessionStart+activity) ⇒ path updates; activity-without-field ⇒ no change. Re-fold the fixture stream and diff projections.

## Acceptance

- [ ] A failed-resume event sequence (SessionStart then SessionEnd, no activity) leaves a previously recorded transcript_path intact.
- [ ] A genuine resume's first activity event updates transcript_path to the live value; an activity event lacking the field changes nothing.
- [ ] Re-folding the event stream produces projections identical to the incremental fold.

## Done summary
Activity-gate the transcript_path fold guard in the reducer: seed once at INSERT, then move only on proven-live keep-set activity (UserPromptSubmit/Stop); a bare SessionStart (incl. the failed-resume SessionStart+SessionEnd pair) can no longer clobber the last good path. Pre/PostToolUse excluded for post-shed re-fold determinism.
## Evidence
