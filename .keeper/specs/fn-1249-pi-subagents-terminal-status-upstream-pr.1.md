## Description

**Size:** M
**Files:** src/agent-manager.ts, src/agent-runner.ts, src/output-file.ts, test/

### Approach

Three interlocking honesty fixes to subagent result plumbing, shipped as one
focused upstream PR (branch off master; the in-flight
fix/nested-subagent-spawn-ctx branch is a separate PR). (1) A subagent whose
final assistant turn is a provider error, abort, or empty `length` stop must
surface as a terminal FAILURE carrying stopReason + errorMessage — never as
`status:"completed"` with `result:""`; only a non-empty textual result may
classify completed. (2) The response collector must reset only on an
assistant `message_start` (user/tool-result messages also emit that event,
so the current reset is fragile). (3) Output-file streaming indexes
`session.messages` by a running count that compaction invalidates
(compaction replaces the array; the stale index halts streaming forever) —
switch to event-driven appends or re-anchor on compaction. Follow upstream
CONTRIBUTING: focused PR, own-voice prose, tests for changed behavior
(mirror merged PR #128's dedicated-test-file style), lint + typecheck +
test + build all green (the 3 subagents-print-mode-e2e failures are
pre-existing environmental — verify they fail identically on master before
dismissing). Deliverable stops at: branch pushed to origin
(possibilities/pi-subagents) + PR title/body drafted in the epic notes —
do NOT open the upstream PR; that is the human's call.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent-manager.ts:293-295 — unconditional `status = "completed"` on prompt resolution
- src/agent-runner.ts:675 — response text collection; :259 — collector reset on every message_start
- src/output-file.ts:61-99 — writtenCount indexing vs compaction replacing session.messages
- pi core's empty-error-turn shape: pi-agent-core dist agent-loop (exhausted provider failures
  return normally as empty assistant messages with stopReason:"error" + errorMessage)
- Incident evidence: ~/docs/pi-subagents-runaway-freeze.md (legs with stopReason "length" /
  "fetch failed" captured as completed+empty)
- Upstream norms: CONTRIBUTING.md; merged PR #128 for test style; keeper's task-facade guard
  (plugins/keeper/pi-extension/task-facade.ts) already fails loud on empty completed events —
  keep semantics compatible with it.

## Acceptance

- [ ] A subagent ending on a provider-error/aborted/empty-length turn produces a terminal
      failure event carrying its stop reason — never completed-with-empty-result — and a
      non-empty textual result still completes; both directions pinned by new tests that
      fail on unpatched master.
- [ ] Output streaming to the output file survives a session compaction (test or verified
      repro), and the collector only resets on assistant message starts.
- [ ] All four upstream checks pass locally except only the pre-existing
      subagents-print-mode-e2e failures (verified identical on master); branch pushed to
      origin with a drafted PR title/body recorded in the Done summary; no PR opened.

## Done summary
Three honesty fixes to subagent result plumbing, shipped as one focused branch off master. Commit a8a5143 on branch keeper/epic/fn-1249-pi-subagents-terminal-status-upstream-pr, pushed to origin (possibilities/pi-subagents). All four upstream checks green (lint, typecheck, test, build); the pre-existing subagents-print-mode-e2e failures did not manifest (isolated e2e green; master full-suite baseline showed the suite green apart from the new tests). New tests A/B-verified: 10 new fix-pinning tests fail on unpatched master and pass patched (685->695 passed). PR NOT opened (human's call).

--- DRAFTED PR TITLE ---
fix: report subagent runs that end without output as failures

--- DRAFTED PR BODY ---
## Problem

A subagent whose final assistant turn is a provider error, an abort, or an empty length stop is reported as status "completed" with an empty result — the caller sees "No output" and a failed run looks like a silent success. Two issues compound it: the response collector resets on every message_start (which also fires for user and tool-result messages), so a trailing tool-result turn can wipe an already-captured answer; and the output-file streamer indexes session.messages by a running count that compaction invalidates (compaction replaces the array), which halts transcript streaming for the rest of the run.

## Changes

- Terminal-status propagation: a run that produces no usable text now resolves to a terminal failure carrying its stop reason and the provider error message, instead of a completed run with an empty result. Only a non-empty textual result classifies as completed (an earlier turn's answer still completes even if a later turn errors).
- Collector reset narrowed: collectResponseText resets only on an assistant message_start, so user/tool-result turns no longer discard the collected answer.
- Compaction-safe output streaming: streamToOutputFile re-anchors its write index on compaction_end, so post-compaction turns keep streaming.

## Testing

npm run lint, typecheck, test, and build all pass. New tests pin both directions and were A/B-verified against unpatched master: test/terminal-status.test.ts (classification + manager status wiring), test/agent-runner.test.ts (collector survives a trailing tool-result turn; runAgent surfaces a terminal failure), test/output-file.test.ts (streaming survives a compaction).
## Evidence
