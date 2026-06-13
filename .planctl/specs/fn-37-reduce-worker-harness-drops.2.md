## Description

**Size:** S
**Files:** none (read-only investigation; findings land in this task's Done summary / Evidence)

### Approach

One observed worker spawn ran with NO Edit/Write tools in its universe while
workers normally use Edit heavily (6,329 Edit PreToolUse events across
plan:worker-* in the keeper db). The worker wrote every file via Bash heredocs
from turn 1 and its `ToolSearch("select:Edit")` returned "No matching deferred
tools found" — so Edit was neither direct nor deferred. Establish where its
tool universe got narrowed. Hypothesis ladder, cheapest first:

1. Orchestrator allowlist inheritance — the work skill's own frontmatter
   `allowed-tools` is `Bash(planctl:*), Read, Glob, Task, SendMessage`; check
   whether a Task() subagent spawned from a skill context inherits that
   narrowed set in the harness version involved (transcript records
   `"version": "2.1.176"`).
2. Dispatch-env divergence — the session was autopilot-dispatched
   (`claude --model sonnet --effort max --arthack-no-confirm '/plan:work …'`
   via the claudewrap alias -> agentuse profile routing -> per-profile
   CLAUDE_CONFIG_DIR). Compare the selected profile dir's settings against a
   session where workers DID have Edit.
3. Harness regression — diff Claude Code versions between Edit-bearing and
   Edit-less worker sessions (every transcript line carries `version`).

Deliverable is findings only: root cause with evidence, or "un-reproducible"
with every checked surface listed. If the cause implies a fix (settings
change, claudewrap change, upstream bug report), write it up as a follow-up
candidate in the Done summary — do not implement it here.

### Investigation targets

**Required** (read before coding):
- ~/.claude/projects/-Users-mike-code-tmux0r/26c3c47b-bbd0-43aa-90c9-2c035def81a3/subagents/agent-a18690c9f6b1533cd.jsonl — the Edit-less worker transcript (ToolSearch miss at ~line 79; heredoc writes from ~line 51)
- template/skills/work.md.tmpl:156-166 — the cold Task() spawn surface (prompt is config-only; no tool restriction visible)
- keeper db (read-only): `SELECT agent_id, COUNT(*) FROM events WHERE agent_type LIKE 'plan:worker%' AND tool_name='Edit' AND hook_event='PreToolUse' GROUP BY agent_id` — partition Edit-bearing vs Edit-less workers, then correlate by session/version/profile

**Optional** (reference as needed):
- /Users/mike/code/keeper/src/autopilot-worker.ts:249-262 — buildWorkerCommand, the dispatch argv
- /Users/mike/code/claudewrap/src/main.ts — profile routing that sets CLAUDE_CONFIG_DIR per launch

### Risks

- Single-occurrence anomaly may not reproduce — the enumerated-surfaces exit criterion exists so the task terminates cleanly instead of chasing ghosts.

### Test notes

No tests — read-only forensics. Evidence is queries run + transcript excerpts
quoted in the task Evidence section.

## Acceptance

- [ ] Edit-bearing vs Edit-less worker sessions partitioned from keeper db with counts (is the anomaly a one-off or a class?)
- [ ] Root cause identified with quoted evidence, OR declared un-reproducible with every checked surface (orchestrator allowlist, profile settings, harness version) listed
- [ ] Any implied fix written as a follow-up candidate in the Done summary; zero code changes in this task

## Done summary

## Evidence
