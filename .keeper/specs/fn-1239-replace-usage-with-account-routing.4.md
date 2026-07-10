## Description

**Size:** M
**Files:** src/agent/main.ts, src/agent/dispatch.ts, src/agent/harness.ts, src/agent/state-sharing.ts, src/agent/shadow-profiles.ts, src/resume-resolve.ts, src/transcript/claude.ts, test/agent-profile-bootstrap.test.ts, test/agent-state-sharing.test.ts, test/agent-shadow-profiles.test.ts, test/resume-resolve.test.ts, test/transcript-claude.test.ts

### Approach

Remove Keeper's account/profile catalog, automatic profile choice, `CLAUDE_CONFIG_DIR` construction, Claude and Pi profile farms, shadow-profile doctor, and profile-based resume/transcript scans. claude-swap exclusively owns any managed-account session directory; Keeper neither discovers nor repairs its private layout.

Preserve the independent global-instruction guards for Claude, Pi, and Codex. Keep the install-time seed of canonical Claude settings, but delete launch-time settings drift comparison, repair, bypass, and fail-loud behavior: after installation the live `~/.claude/settings.json` may evolve locally, and claude-swap shares that live file into managed sessions. Resume discovery uses canonical shared history and normal harness-native IDs, while each invocation's account choice remains task 2's concern.

The clean break has no compatibility launcher and no credential conversion. Archival is an operator rollout action against the retired directories, not a hidden runtime reader or an automatic mutation from a reducer/daemon worker.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/state-sharing.ts:656 — generic drift comparison and divergence machinery whose settings-specific branch retires
- src/agent/state-sharing.ts:681 — canonical Claude settings and instruction leaves that must be split
- src/agent/state-sharing.ts:930 — combined canonical-link guard and Claude profile-farm behavior to separate
- src/agent/state-sharing.ts:1057 — Pi canonical instruction leaf plus profile-farm behavior
- src/agent/main.ts:2688 — unconditional Claude state-sharing call
- src/agent/main.ts:2722 — Pi profile-sharing call
- src/agent/main.ts:2803 — profile `CLAUDE_CONFIG_DIR` assignment
- src/agent/shadow-profiles.ts:1 — profile-root diagnostics to retire
- src/resume-resolve.ts:562 — profile config-root resume search
- src/transcript/claude.ts:98 — transcript scan across `.claude-profiles`

**Optional** (reference as needed):
- src/agent/state-sharing.ts:397 — profile-name/path guards whose creation surface retires
- src/agent/dispatch.ts:185 — `profiles check` command surface
- test/agent-profile-bootstrap.test.ts:482 — active profile/environment expectations to replace

### Risks

Global-instruction guards are not account farms and must survive, but the Claude settings drift guard is intentionally removed while its install seed remains. Removing profile-root searches before `--share-history` routing lands would hide conversations; the task dependency prevents that order. Existing directories may contain credentials, so no test or runtime cleanup may inspect, copy selectively, or print their contents.

### Test notes

Rewrite fixtures around canonical roots and account-route injection rather than profile names. Assert no production code creates or scans `.claude-profiles` or `.pi-profiles`; global instruction links still follow their existing contracts; a missing/divergent/live Claude settings file is never compared, repaired, or launch-blocking after the install seed. Use sandbox homes only.

### Detailed phases

1. Separate global-instruction guards from profile-farm loops and remove the settings-specific drift detector while retaining install-time stow seeding.
2. Remove profile discovery, precedence, environment, diagnostics, and Pi coupling from launch orchestration.
3. Collapse resume/transcript discovery onto canonical/shared-history roots.
4. Delete dead profile modules and replace broad profile tests with negative-boundary tests.

### Alternatives

Retaining read-only legacy launch support was rejected by the clean-break decision. Teaching Keeper the claude-swap session-directory layout was rejected as private coupling. Automatically importing profile credentials was explicitly rejected.

### Non-functional targets

No Keeper runtime path reads, creates, repairs, or identifies accounts from either retired profile root. Global-instruction sharing stays byte-compatible, while settings drift work becomes zero-cost at launch. Any operator archive operation is collision-safe, mode-restricted, and outside folds/workers/tests.

### Rollout

Merge only after managed/default launch and cross-account resume tests pass. Leave physical host directories untouched until the post-finalize operator archive step; code removal makes them inert immediately.

## Acceptance

- [ ] Keeper performs no account selection or identity inference through `CLAUDE_CONFIG_DIR`, profile names, or profile directories.
- [ ] No Keeper launch creates, scans, repairs, or routes through `.claude-profiles` or `.pi-profiles`.
- [ ] Claude, Pi, and Codex global-instruction guards remain intact without profile-farm loops.
- [ ] Install-time Claude settings seeding remains, but no launch-time code compares, repairs, rejects, or provides a bypass for settings drift.
- [ ] Resume and transcript discovery remain correct through canonical/shared history and harness-native IDs.
- [ ] The profile-check command, profile environment variables, shadow-profile module, and profile-specific tests are retired.
- [ ] No credential migration, legacy launcher, or runtime archive reader remains.

## Done summary

## Evidence
