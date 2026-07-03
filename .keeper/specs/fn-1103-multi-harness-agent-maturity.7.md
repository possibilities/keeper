## Description

**Size:** M
**Files:** src/resume-descriptor.ts, src/restore-set.ts, src/restore-worker.ts, src/exec-backend.ts, src/bus-wake.ts, test/resume-descriptor.test.ts, test/restore-set.test.ts

### Approach

Make resume/restore harness-aware end to end. resumeTarget(job) becomes
per-harness: claude keeps title-else-job_id; codex/pi/hermes use the stored
jobs.resume_target and a NULL target renders the agent visibly not-resumable
(excluded with a reason) instead of erroring. Restore buckets and each
RestoreAgent gain a harness tag; the relaunch argv builder emits the descriptor's
resume verb per harness — claude --resume <target>, codex resume <uuid>
(subcommand form), pi --session <id>, hermes --resume <id> (verify the hermes
flag against the live CLI; MEDIUM confidence) — routed through keeper agent
<harness> so a resume relaunch re-enters the launcher and writes a fresh birth
record (new pid/start_time re-seed presence). Human display twin strings become
per-harness. bus-wake routes through the same descriptor path (creators remain
claude today; the path just stops assuming it).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/resume-descriptor.ts:39-78 — resumeTarget + the claude display twin
- src/restore-set.ts:221-235 and :747-754 — bucket shape and the relaunch spec construction
- src/exec-backend.ts:892-948 — buildKeeperAgentLaunchArgv (the hardcoded agent claude token and --resume emission at :916-921)
- src/agent/args.ts:174-221 — per-harness resume predicate forms the descriptor should mirror
- src/restore-worker.ts:283 — where buckets are backend-tagged today (harness tag lands beside it)

**Optional** (reference as needed):
- src/bus-wake.ts — the wake relaunch call site

### Risks

- restore-agents --apply fail-closed semantics (non-zero while autopilot unpaused) must be preserved unchanged
- The codex subcommand resume form breaks the flag-only argv assumption — builder must support verb-position args

### Test notes

Per-harness argv cases in resume-descriptor/restore-set tests (claude unchanged,
codex subcommand, pi --session, hermes --resume); NULL-resume_target exclusion
case; harness routing on mixed-harness restore sets.

## Acceptance

- [ ] The restore descriptor lists non-claude agents with their harness and native resume target; mixed-harness sets route each agent to its own resume argv
- [ ] A non-claude job with no resume target is reported not-resumable with a reason, and the rest of the set still restores
- [ ] Claude restore behavior and the fail-closed --apply gate are byte-for-byte unchanged
- [ ] A resumed non-claude session re-appears as a tracked row (fresh birth record on relaunch)

## Done summary

## Evidence
