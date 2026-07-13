## Description

**Size:** M
**Files:** src/agent/harness.ts, src/agent/resume-policy.ts, src/agent/resume-resolve-cli.ts, src/resume-resolve.ts, src/resume-descriptor.ts, src/exec-backend.ts, src/restore-set.ts, src/restore-worker.ts, src/restore-verify.ts, src/tabs-core.ts, cli/tabs.ts, src/bus-wake.ts, test/agent-resume-policy.test.ts, test/resume-descriptor.test.ts, test/resume-resolve.test.ts, test/exec-backend.test.ts, test/restore-set.test.ts, test/restore-worker.test.ts, test/tabs.test.ts, test/bus-wake.test.ts

### Approach

Allow resume/restore argv only for Claude/Pi. Keep the narrow null/empty Claude behavior required by current Claude rows; every non-empty unregistered value fails before process creation with no retired display or partial policy.

### Investigation targets

*Verify before relying — these refs move with the repo.*

**Required** (read before coding):
- `src/agent/harness.ts:304` — broad fallback.
- `src/agent/resume-policy.ts:199` — candidate normalization.
- `src/resume-descriptor.ts:56` — resume selection.
- `src/exec-backend.ts:1109` — final argv seam.
- `src/restore-set.ts:622`, `cli/tabs.ts:890`, `src/bus-wake.ts:377` — restore/wake consumers.

**Optional** (reference as needed):
- `docs/adr/0034-resume-by-name-resolves-through-bus-identity.md` — retained lookup principle.

### Risks

A helper returning Claude for unknown strings remains exploitable even if help omits those strings.

### Test notes

Replace Codex/Hermes resumable fixtures with ordinary unsupported failures across direct resume, restore, tabs, wake, and exec; retain Claude-null and Pi attach coverage.

### Detailed phases

1. Replace broad normalization with Claude/Pi plus empty-Claude parsing.
2. Remove retired probes/descriptors/command generation.
3. Propagate ordinary unsupported failures through every execution path.
4. Restrict non-Claude attach verification to Pi.

### Alternatives

Retired result variants and partial restore are rejected.

### Non-functional targets

Unsupported values never reach process creation; supported restore remains deterministic.

### Rollout

Old generated retired commands are not migrated and fail normally.

## Acceptance

- [ ] Resume, restore, tabs, wake, and exec build argv only for Claude/Pi.
- [ ] Null/empty Claude behavior remains.
- [ ] Non-empty unregistered values fail before process creation without special compatibility output.
- [ ] Claude/Pi suites pass.

## Done summary
Restricted resume, restore, tabs, wake, and exec argv-building paths to Claude/Pi via harnessOrClaude; empty/null harness remains Claude, and any unregistered non-empty value fails before process creation with no retired-harness compatibility treatment.
## Evidence
