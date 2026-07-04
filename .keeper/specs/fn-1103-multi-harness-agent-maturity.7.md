## Description

**Size:** M
**Files:** src/resume-descriptor.ts, src/restore-set.ts, src/restore-worker.ts, src/exec-backend.ts, src/bus-wake.ts, the keeper tabs command family (as landed by fn-1102), test/resume-descriptor.test.ts, test/restore-set.test.ts, test/tabs.test.ts

### Approach

Make resume/restore harness-aware end to end, EXTENDING the keeper tabs
browser-grade restore system (fn-1102 — this epic depends on it; read its landed
shape first): generation selection, keeper tabs list/restore, the setup-tmux
offer, and the durable revive side-file all carry a harness tag per agent and
emit per-harness resume argv. resumeTarget(job) becomes per-harness: claude
keeps its fn-1102 exact-session-uuid form (cwd prefix stays load-bearing);
codex/pi/hermes use the stored jobs.resume_target, and a NULL target renders
that agent visibly not-resumable (excluded with a reason, the rest of the
generation still restores). Per-descriptor resume verbs: claude --resume
<uuid>, codex resume <uuid> (subcommand form — the argv builder must support
verb-position args), pi --session <id>, hermes --resume <id> (verify the
hermes flag live; MEDIUM confidence). Every relaunch routes through keeper
agent <harness> so it re-enters the launcher (fresh birth record, original
job_id preserved per the birth-record contract). The revive side-file
single-quotes every interpolated field per fn-1102's untrusted-data rule —
harness resume argv included. Human display twins become per-harness. bus-wake
routes through the same descriptor path (creators remain claude today; the
path stops assuming it). Restore-gating semantics (fail-closed --apply while
autopilot unpaused) are preserved under whichever spelling fn-1102 lands.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- The landed fn-1102 surface: keeper tabs list/restore/dump, the generation selection, the revive side-file writer, and where resume commands are composed — this task layers harness routing onto exactly those seams
- src/resume-descriptor.ts:39-78 — resumeTarget + display twins (pre-fn-1102 line refs; re-locate after it lands)
- src/exec-backend.ts:892-948 — buildKeeperAgentLaunchArgv (the hardcoded agent claude token and --resume emission)
- src/agent/args.ts:174-221 — per-harness resume predicate forms the descriptor mirrors
- src/restore-worker.ts:283 — bucket tagging site

**Optional** (reference as needed):
- src/bus-wake.ts — the wake relaunch call site

### Risks

- fn-1102 lands first and reshapes these files — re-locate all line refs against its landed state before coding; the dep edge enforces ordering
- The codex subcommand resume form breaks flag-only argv assumptions
- Revive-script interpolation of harness argv is an untrusted-data-to-code boundary — follow fn-1102's quoting rule exactly

### Test notes

Per-harness argv cases (claude unchanged, codex subcommand, pi --session,
hermes --resume); NULL-resume_target exclusion; mixed-harness generation
restore in tabs tests; revive side-file quoting cases with hostile titles/cwds.

## Acceptance

- [ ] keeper tabs list/restore and the durable revive script present mixed-harness generations, each agent tagged with its harness and restored via its own resume argv
- [ ] A non-claude agent with no resume target is reported not-resumable with a reason, and the rest of the generation still restores
- [ ] Claude restore behavior and the fail-closed apply gate are unchanged under fn-1102's spelling
- [ ] A resumed non-claude session re-appears as the SAME tracked row (original job id, fresh birth record)

## Done summary
Made resume/restore harness-aware end to end: resumeTarget/buildResumeCommand/buildKeeperAgentLaunchArgv route each agent through its harness's native resume verb (claude --resume, codex resume, pi --session, hermes --resume) off the descriptor registry; RestoreCandidate carries a harness tag and a non-claude agent with no resolved target is reported not-resumable while the rest restore; revive.sh + bus wake thread the harness and JOBS_DESCRIPTOR serves harness/resume_target; claude paths stay byte-identical.
## Evidence
