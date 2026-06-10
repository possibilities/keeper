## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/resume-descriptor.ts, src/exec-backend.ts, test/autopilot-worker.test.ts, test/resume-descriptor.test.ts, test/restore-agents.test.ts, test/exec-backend.test.ts

### Approach

Remove the `--plugin-dir work-plugins/<tier>` push from keeper's worker
launch and resume paths. The `plan` plugin is always loaded, and after task 2
the `/plan:work` skill spawns `plan:worker-<tier>` from the emitted
`worker_agent`, so the launcher no longer needs to select a tier-plugin.
Delete `workPluginDir(tier)` and the `checkWorkPluginManifest` pre-flight
guard (its job — turning a missing tier-plugin into a visible DispatchFailed —
is now covered by the planctl check-generated guard on `agents/worker-<tier>.md`).
Keep every `task.tier` read intact (board/projection/resume-target via
`tierForJobFromEpics` are unaffected). This is the **gating task** — see the
epic Rollout for the autopilot-off → bounce-keeperd cutover that wraps it.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts — `buildWorkerCommand` ~442-458 (the `flags.push("--plugin-dir", workPluginDir(tier))` ~453, remove), `workPluginDir` ~351-358 (delete), `checkWorkPluginManifest` ~360-410 (delete + its call site)
- src/resume-descriptor.ts — `buildResumeCommand` ~52-64 (the `--plugin-dir` push ~59, remove), the `workPluginDir` import ~19 (remove cleanly)
- src/exec-backend.ts:~701 — argv-peeling comment references `--plugin-dir`; verify the peel logic does not depend on the flag's presence/position once it is gone
- test/autopilot-worker.test.ts ~592-603, test/resume-descriptor.test.ts ~64-73, test/restore-agents.test.ts ~217-227, test/exec-backend.test.ts ~701,1418 — all assert `--plugin-dir` presence; flip to assert ABSENCE

### Risks

`workPluginDir` is imported by resume-descriptor.ts — deleting it ripples;
remove the import to keep the build clean. Do NOT touch `task.tier` reads.
The worker running this task is itself launched by the OLD daemon (still
passing `--plugin-dir`) — that is fine; the change only takes effect after
keeperd is bounced (Rollout step 4).

### Test notes

`cd ~/code/keeper && bun test --parallel --timeout=30000` green with the four
test files inverted. Confirm no remaining `workPluginDir` / `work-plugins`
references in `src/` except doc-comments (those are rewritten in task 5).

## Acceptance

- [ ] `--plugin-dir` no longer pushed in `buildWorkerCommand` or `buildResumeCommand`
- [ ] `workPluginDir` and `checkWorkPluginManifest` deleted; imports cleaned; build passes
- [ ] all `task.tier` reads (board/projection/resume) preserved
- [ ] four keeper test files inverted to assert `--plugin-dir` absence; `bun test` green

## Done summary
Dropped the --plugin-dir work-plugins/<tier> push from keeper's worker launch (buildWorkerCommand) and resume (buildResumeCommand) paths; deleted workPluginDir, checkWorkPluginManifest, the pre-launch manifest guard + WorkPluginCheck dep, and the dead PLANCTL_ROOT export. All task.tier reads (board/projection/resume via tierForJobFromEpics) preserved; four test files inverted to assert --plugin-dir absence. tsc + biome clean, keeper suite green (parallel-only integration flake is pre-existing, unrelated).
## Evidence
