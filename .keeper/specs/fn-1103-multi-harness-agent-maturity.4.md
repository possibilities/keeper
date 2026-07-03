## Description

**Size:** M
**Files:** src/birth-record.ts (new), src/agent/launch-handle.ts, src/agent/launch-config.ts, src/agent/tmux-launch.ts, test/helpers/sandbox-env.ts, test/birth-record.test.ts (new)

### Approach

A dep-free leaf module (node:* only — the launcher leaf must stay db-free, pinned
by the launch-handle depgraph test) defining the birth-record contract:
{schema_version, session_id, harness, pid, start_time (platform-tagged), cwd,
spawn_name, config_dir, backend_exec_type/session_id/pane_id, worktree, launch_ts,
resume_target?} with serialize/parse and a maildir-style atomic write (write to
tmp/, fsync, rename into new/; one record per file; single write call). The
keeper agent launcher writes exactly one record per managed detached launch for
ALL FOUR harnesses (every managed launch — dispatch, restore, wake, handoff —
re-execs through keeper agent, so this is the single choke point; resume
relaunches also write a fresh record). Identity: claude/pi record their pinned
session uuid (resume_target = session_id); codex/hermes get a keeper-minted uuid.
Codex launches additionally export CODEX_INTERNAL_ORIGINATOR_OVERRIDE=job_id;
ALL launches export KEEPER_JOB_ID=job_id. Pid discipline: Bun cannot execve, so
the in-pane wrapper spawns the harness as a child and records the CHILD's pid
plus its start_time probed immediately post-spawn (platform-tagged, same probe
family as the seed-sweep helper — copy it into the leaf if the import drags db).
Never record the wrapper or pane shell pid. Tree at
~/.local/state/keeper/births/ overridable via a new KEEPER_BIRTH_DIR env; add it
to sandboxEnv's state classes so tests never strand at the production path.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/dead-letter.ts:247-328 — EventLogRecord serialize/parse round-trip (the NDJSON contract discipline to mirror)
- src/seed-sweep.ts:101 — readOsStartTime platform-tagged probe (check its import chain before importing from the leaf)
- src/agent/launch-handle.ts — where the detached spawn happens and env is composed (the write site); test/agent-launch-handle-depgraph.test.ts (the db-free pin)
- src/agent/tmux-launch.ts:22 — CAPTURE_FORMAT (extend with pane_pid only if needed for verification; the recorded pid is the spawned child's)
- test/helpers/sandbox-env.ts — the six state classes; add the births tree

**Optional** (reference as needed):
- src/codex-trust.ts — the dep-free leaf conventions (fail-open, env-overridable logging)

### Risks

- A forking harness wrapper would orphan the recorded pid; probe-after-spawn has a small race if the child dies instantly — tolerated, seed-sweep validates against the recorded start_time
- Writing the record after spawn means a launcher crash in between leaves an untracked session — accepted (same class as a claude session whose SessionStart hook never fires)

### Test notes

Round-trip serialize/parse property tests; torn/partial file rejected by parse;
maildir write leaves no partial file visible in new/; env exports asserted in
launch-config tests; sandboxEnv addition verified by an isolation test.

## Acceptance

- [ ] Every managed detached launch of any harness produces exactly one complete birth record in the births tree, atomically visible
- [ ] Records carry the spawned harness child's pid and platform-tagged start_time, never the wrapper's
- [ ] Codex launches carry the originator override env; all launches carry the keeper job id env
- [ ] The launcher leaf remains db-free (depgraph pin green) and the births tree is sandboxed in tests

## Done summary

## Evidence
