## Description

**Size:** M
**Files:** src/resume-descriptor.ts, scripts/restore-agents.ts, src/restore-worker.ts, test/restore-agents.test.ts, test/restore-worker.test.ts

Wire the execution path to the new derivation: resume by UUID, make restore-agents a thin presenter over `restore-set.ts`, and demote the restore-worker's freeze machinery.

### Approach

Change `resumeTarget` (resume-descriptor.ts:33) to return `job_id` (the session UUID — exact, rename-proof) with the latest `title` carried as a display label only; `buildResumeCommand` keeps the `cd <cwd> && claude --resume "<uuid>"` shape. This is the shared substrate for THREE producers (scripts/resume.ts, restore-worker, restore-agents) — they must stay byte-identical, so change it once and verify all three. Rewrite scripts/restore-agents.ts to derive candidates from `restore-set.ts` against its own read-only DB connection (dropping the `last_session ‖ current` precedence reader and the UDS skip-set round-trip — the skip-set now comes from the same DB read); keep `INTER_WINDOW_PAUSE_MS=500` pacing and the `--apply`/dry-run shape; daemon-down now works first-class. Strip the restore-worker freeze machinery (`last_session` tier, the `>0→0` collapse-freeze, `epochHighWater`, the boot-promote precedence chain) but KEEP the dumb continuous `current` mirror (disaster fallback + window_index source for T2).

### Investigation targets

**Required** (read before coding):
- src/resume-descriptor.ts:33 `resumeTarget`, :60-67 `buildResumeCommand` (the three byte-identical producers)
- scripts/resume.ts, src/restore-worker.ts — the other two producers that must move together
- scripts/restore-agents.ts:8-46 precedence reader (replace), :240-432 UDS query helper, :580 `INTER_WINDOW_PAUSE_MS`, :598 `applyRestore`
- src/restore-worker.ts:204 `RESTORE_SCHEMA_VERSION`, :278-298 `RestoreDescriptor`, :1049-1063 freeze write/`epochHighWater` (strip last_session, keep current)

**Optional**:
- The earlier session confirmation that a transcript resolves directly by `job_id` UUID (no picker)

### Risks

- `claude --resume <uuid>` on a stale/GC'd UUID may fall into the picker; a paced restore of N stale UUIDs could open N pickers — confirm exact-UUID re-attach and handle the missing-transcript case.
- The byte-identical-3-producers invariant: a partial change breaks resume.ts/restore-worker; assert all three emit the identical command.
- Demoting the restore-worker must not remove window_index capture (T2 depends on the snapshot) or the dumb `current` mirror (daemon-down fallback).

### Test notes

Assert restore-agents produces UUID-based resume commands for a fixture candidate set; a renamed session restores by UUID. Test daemon-down: derivation + restore plan succeed against a read-only DB with no socket. Assert the dumb `current` mirror still writes. `sandboxEnv` (all five KEEPER_* paths incl. KEEPER_RESTORE_FILE) for subprocess tests.

## Acceptance

- [ ] `resumeTarget` returns `job_id`; all three producers stay byte-identical; a renamed session restores correctly.
- [ ] restore-agents derives from `restore-set.ts` (own read-only connection), works with keeperd stopped, keeps 0.5s pacing.
- [ ] restore-worker freeze machinery removed; dumb `current` mirror + window_index capture retained.
- [ ] `bun run test:full` green.

## Done summary

## Evidence
