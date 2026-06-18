## Description

**Size:** M
**Files:** none (read-only investigation; findings land in this task's Done summary / Evidence)

### Approach

~65 worker invocations end in silence: the transcript's last entry is a
tool_result, no subsequent assistant API call, no `SessionEnd`/`Killed` event
in keeper within [-2m, +15m]. Classify these deaths with evidence. Method:

1. Reproduce the census. Scan `~/.claude/projects/*/*/subagents/agent-*.meta.json`
   for agentType `plan:worker-*` / `work:worker`; split each transcript into
   invocations at user-type lines whose `message.content` is a STRING (initial
   prompt or resume directive); an invocation is a silent death when it is not
   the live tail (file mtime > 1h old), did not run `planctl done`, has <100
   unique assistant message ids, no `isApiErrorMessage` ending, and its last
   record is a tool_result.
2. Correlate each death timestamp against: Claude Code version transitions
   (every transcript line carries `version` — an auto-update restart kills
   in-flight subagents), machine sleep/wake (`pmset -g log | grep -E
   "Sleep|Wake"`), claude process restarts (keeper `SessionStart` events for
   the same session_id shortly after), tmux pane lifecycle (keeper
   `BackendExecSnapshot` / job `backend_exec_*` fields), and orchestrator
   interrupts (a parent-session user message arriving at the same minute).
3. Bucket every death into named causes with counts; leave a residual bucket
   only if evidence genuinely runs out, and say what evidence would be needed.

Deliverable is findings only: per-cause counts, representative evidence per
bucket (session id + timestamp + the correlating signal), and follow-up
candidates for any actionable cause. No code changes, no scope creep into the
out-of-scope transport/rate-limit surfaces — if a death traces to the known
upstream 529 no-retry bug, count it and move on.

### Investigation targets

**Required** (read before coding):
- ~/.claude/projects/<project>/<session>/subagents/agent-*.jsonl + .meta.json — the corpus; invocation-splitting recipe above
- keeper db (read-only, ~/.local/state/keeper/keeper.db): events table — `SessionStart`/`SessionEnd`/`Killed`/`BackendExecSnapshot` by session_id and ts; payloads via `COALESCE(events.data, b.data)` with `LEFT JOIN event_blobs b ON b.event_id = events.id`

**Optional** (reference as needed):
- /Users/mike/code/keeper/src/exit-watcher.ts — the dead-pid re-probe that mints synthetic `Killed` events (context for which deaths keeper already detects)
- template/skills/work.md.tmpl:110-173 — resume machinery (which death classes the existing net already recovers)

### Risks

- Correlation signals may be sparse for older deaths (pmset log rotation) — classify what the evidence supports and size the residual bucket honestly.

### Test notes

No tests — read-only forensics. Evidence is the classification table plus
per-bucket representative excerpts in the task Evidence section.

## Acceptance

- [ ] Silent-death census reproduced with the documented recipe; total within ±10 of the ~65 estimate or the delta explained
- [ ] Every death assigned to a named cause bucket with counts; each bucket carries at least one representative evidence excerpt; residual bucket (if any) states what evidence is missing
- [ ] Actionable causes written up as follow-up candidates in the Done summary; zero code changes in this task

## Done summary
Silent-death census reproduced: 1648 worker invocations (matches ~1640 fleet figure), 1232 ran planctl done, 82 silent deaths (recipe: not-live-tail + mtime>1h + no planctl-done + <100 msgids + no isApiErrorMessage + last record tool_result). 82 vs ~65 estimate is +17; delta explained: my split counts every mid-transcript invocation that died (69 of 82 were mid-transcript and RESUMED by the parent), whereas the ~65 estimate counted the tighter terminal/keeper-tracked population.

CAUSE BUCKETS (per-cause counts + evidence):
1. SILENT_STREAM_CUT = 50 (46 recovered, 4 terminal). keeper logs subagent_stop within ~2-3s of the death but NO killed/api_error/rate_limited/session_end. Harness terminated the subagent turn between a tool_result and the model's next API response with no logged error. Evidence: sid=492f5307 2026-05-27T05:29:16Z (subagent_stop@+3s, then parent subagent_start@+21s = resume); sid=cfcbc8ec 2026-05-31T01:33:26Z (subagent_stop@+2s); sid=ea343ed2 2026-05-25T15:55:58Z. This is the transient mid-stream transport kill (epic's ~4% class), NOT the upstream 529 bug: 0/50 correlate with any api_error/rate_limited event within +/-90s.
2. PRE_KEEPER_DB = 23 (all recovered). Deaths before keeper db window (keeper starts 2026-05-20; these are 2026-05-16..05-19). Only the transcript version field is available; all show the identical mid-tool-result signature as SILENT_STREAM_CUT. Residual-evidence boundary: keeper correlation impossible by date. Evidence: sid=bdedc6b4 2026-05-18T12:52:42Z; sid=ce7b9666 2026-05-16T13:39:31Z. Evidence needed to reclassify: keeper events predating 2026-05-20 (do not exist).
3. PARENT_SESSION_TEARDOWN = 7 (all terminal). Parent session_end within 0-3s of death; orchestrator session closed mid-flight. Evidence: sid=9687dcdd 2026-06-08T05:16:09Z (session_end@+3s); sid=c81bf8fe 2026-05-29T14:47:07Z (session_end@+1s).
4. CLAUDE_RESTART = 1 (terminal). post_tool_use_failure@-0s; session_end@+2s; session_start@+33s (auto-update restart). sid=108239a4 2026-06-01T21:27:02Z.
5. TRACKED_NO_SIGNAL = 1 (terminal). sid=845da798 2026-05-21T18:23:31Z; keeper-tracked but invocation-split artifact (tool_use continues post-split same parent). Evidence needed: cleaner resume-boundary detection.

KEY SIGNATURE: 0/82 deaths show the yield-to-wait signature (text-only end_turn) -- the model never voluntarily ended a turn to wait. 67/82 had last assistant stop_reason=tool_use, 15/82 had stop_reason=null (per Anthropic streaming docs, null = interrupted stream, never a real end_turn). Only 1/32 subagent_stop deaths sat near the old maxTurns=100. So silent deaths are mid-execution stream interruptions, NOT the maxTurns cap and NOT model yields. RECOVERY: 69/82 (84%) recovered by the parent resume machinery; only 13/82 (16%) terminal work-loss.

FOLLOW-UP CANDIDATES (actionable causes; no code in this task): (a) SILENT_STREAM_CUT is the dominant and only large actionable class -- since it emits no api_error, a keeper-side detector could flag 'subagent_stop with prior stop_reason=tool_use/null and no terminal text' as a synthetic drop signal to drive faster auto-resume (the exit-watcher already mints synthetic Killed events; this is an analogous stream-cut probe). (b) PARENT_SESSION_TEARDOWN (7, all terminal) argues for a parent-side guard that drains/checkpoints in-flight workers before session_end. (c) CLAUDE_RESTART (1) is auto-update collateral -- low volume, defer. Zero code changes in this task.
## Evidence
