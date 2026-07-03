## Description

**Size:** M
**Files:** src/birth-record.ts (new), src/agent/main.ts, src/agent/run.ts, src/agent/launch-handle.ts, src/agent/launch-config.ts, src/agent/tmux-launch.ts, test/helpers/sandbox-env.ts, test/birth-record.test.ts (new)

### Approach

A dep-free leaf module (node:* only — the launcher path stays db-free) defining
the birth-record contract: {schema_version, session_id, harness, pid, start_time
(platform-tagged), cwd, spawn_name, config_dir, backend_exec_type/session_id/
pane_id, worktree, launch_ts, resume_target?} with serialize/parse and a
maildir-style atomic write (tmp/ -> fsync -> rename into new/; one record per
file; single write call). SCOPE: NON-CLAUDE harnesses only — claude's hook
SessionStart is authoritative for presence and resume identity, and a second
seed would double-fire the revive arm. WRITE SITE: the inline harness-spawn
choke point where the launcher actually spawns the harness child (the code path
shared by interactive AND detached launches — a detached pane re-execs keeper
agent and passes back through it); NOT the detached-only wrapper. Interactive
parity is the point: a pi session started by hand in a bare terminal registers
exactly like a dispatched one. tmux coordinates come from the inherited carrier
env when present and are absent-tolerated (no pane -> no rename, presence and
killed-detection still work). Identity: pi records its pinned session uuid
(resume_target = session_id); codex/hermes get a keeper-minted uuid; a RESUME
relaunch reuses the ORIGINAL job_id (from the resume target) so the revived
session folds onto the same row instead of minting an orphan. Codex launches
additionally export CODEX_INTERNAL_ORIGINATOR_OVERRIDE=job_id; all non-claude
launches export KEEPER_JOB_ID=job_id. Pid discipline: Bun cannot execve, so the
wrapper spawns the harness child and records the CHILD's pid plus its
start_time probed immediately post-spawn (platform-tagged; copy the probe into
the leaf if the existing helper's import chain drags db). Tree at
~/.local/state/keeper/births/ overridable via KEEPER_BIRTH_DIR; add it to
sandboxEnv's state classes.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/main.ts ~2196+ — the inline runCmd build + spawn via run.ts (the choke point every launch passes through); confirm interactive and detached both route here
- src/agent/run.ts — defaultSpawn / job-control wrapper lifetime (the parent that probes the child)
- src/dead-letter.ts:247-328 — serialize/parse round-trip discipline to mirror
- src/seed-sweep.ts:101 — readOsStartTime platform-tagged probe (check import chain)
- test/helpers/sandbox-env.ts — the state classes; add the births tree
- src/agent/tmux-launch.ts:1044 — why pid is null at detached-wrapper write time (the reason the writer lives inline, not in the wrapper)

**Optional** (reference as needed):
- src/agent/launch-handle.ts:152 — the detached outer path (demoted to pane-coordinate carrier)
- src/codex-trust.ts — dep-free leaf conventions

### Risks

- A forking harness would orphan the recorded pid; probe-after-spawn races an instant child death — tolerated, seed-sweep validates against the recorded start_time
- Launcher crash between spawn and record leaves an untracked session — accepted (same class as a claude session whose hook never fires)
- Missing the choke point (writing only on the detached path) silently breaks interactive parity — the acceptance below pins it

### Test notes

Round-trip serialize/parse property tests; torn/partial file rejected; maildir
write leaves no partial file in new/; interactive-launch (no tmux env) record
carries null pane fields; resume-relaunch record carries the original job_id;
env exports asserted per harness; claude launch writes NO record.

## Acceptance

- [ ] Every keeper agent launch of codex, pi, or hermes — interactive or detached — produces exactly one complete birth record, atomically visible; claude launches produce none
- [ ] Records carry the spawned harness child's pid and platform-tagged start_time, never the wrapper's; absent tmux coordinates are recorded as absent, not fabricated
- [ ] A resume relaunch's record reuses the original job id so the session revives its existing row
- [ ] Codex launches carry the originator override env; all non-claude launches carry the keeper job id env
- [ ] The launcher path remains db-free (depgraph pin green) and the births tree is sandboxed in tests

## Done summary

## Evidence
