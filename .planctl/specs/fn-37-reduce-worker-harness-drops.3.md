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

## Evidence
