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
ROOT-CAUSED. Edit-less worker a18690c9f6b1533cd (plan:worker-xhigh, fn-1-bun-cli-frame-compositor.3, session 26c3c47b, harness 2.1.176) had a tool universe of Read+Bash+ToolSearch as DIRECT tools with Edit/Write absent from BOTH the direct set AND the deferred registry. Transcript proof: L78 'Let me use a precise edit tool. I'll fetch Edit's schema.' -> L79 ToolSearch(select:Edit) -> L80 'No matching deferred tools found' -> L81 'Edit isn't available as a deferred tool. I'll rewrite... via a heredoc' -> 25 cat>file<<EOF heredoc writes from L52 (incl. src/frame.ts written twice as full-file rewrites); zero 'deferred tools are now available' reminder anywhere in the transcript. Worker still reached planctl done shipping all source via Bash. PARTITION: 565 plan:worker agents total -> 411 Edit-bearing, 123 Write-bearing, 430 Edit-or-Write, 135 (24%) NEITHER. So the anomaly is a CLASS, not a one-off. Hypothesis ladder resolved: (1) Orchestrator allowlist inheritance RULED OUT - worker ran 62 non-planctl Bash calls (keeper session-state, ls, grep, mkdir, cat heredocs); the work skill's Bash(planctl:*) allowlist would have denied every one, so the worker had general Bash, not the skill's narrowed set. (2) Per-session/profile env divergence RULED OUT as universal cause - 15 sessions contain BOTH an Edit-bearing AND a neither-class worker, so same session/profile/CLAUDE_CONFIG_DIR/version yields both outcomes; cause is per-SPAWN, not per-environment. config_dir is empty for all 565 workers in the db so it could not be used to discriminate. (3) Harness version: anomaly on 2.1.176, sampled Edit-bearing workers on 2.1.172/2.1.145; version-correlation surface largely unavailable (db stores no version; session transcript_path absent from data blob for 118/135 neither-class agents) so a clean version histogram could not be built - NOT fully confirmed. CONCLUSION: root cause is harness-side deferred-tool population - for some spawns Edit/Write land in neither the direct tool set nor the deferred-tool registry, and no deferred-tools system-reminder is emitted, leaving the worker to fall back to Bash heredocs (the exact giant-heredoc drop mode this epic's hardening prose targets). FOLLOW-UP CANDIDATES (no code here): (a) file an upstream Claude Code report - deferred-tool registry can omit Edit/Write with no 'deferred tools available' reminder, ToolSearch(select:Edit) returns empty; affects 24% of worker spawns. (b) add a Phase-1 worker self-check: if neither Edit nor Write is direct/deferred, ToolSearch(select:Edit,Write) once and BLOCKED:TOOLING_FAILURE if both miss, rather than silently degrading to heredocs. (c) consider declaring Edit,Write in worker.md.tmpl frontmatter allowedTools to force them direct (removes deferred-registry dependency) - needs harness-behavior validation. UN-CONFIRMED surface: precise harness mechanism that decides deferred-registry membership per spawn (not introspectable from transcripts/db); the version-correlation could not be statistically nailed.
## Evidence
