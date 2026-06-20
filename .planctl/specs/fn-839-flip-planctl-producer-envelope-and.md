## Overview

SUPERVISED / DEPLOY-BOUNDARY — DO NOT ARM for autopilot. Human-driven only.
Split out of fn-831 (which landed the daemon-side keystone: reducer mint
`source='plan'`, v75 `file_attributions` migration, api.py). This epic owns the
remaining producer-side name erasure: flip the planctl CLI emit envelope
`planctl_invocation` -> `plan_invocation`, which forces a rebuild + promote of
the human's LIVE `~/.local/bin/planctl` binary (soak + rollback protocol) plus a
migration of the vendored conformance suite. Determinism-neutral: the
`planctl_invocation` READER in `src/reducer.ts` stays forever (19,850 historical
events carry that envelope; re-fold must replay them).

## Quick commands

- `bun run test:full` (keeper side) then the EXCLUDED suites: `bun test plugins/plan/test/` + `test/plan-shim.test.ts`
- `bun run promote` then soak per plugins/plan/CLAUDE.md; `hash -r` / `rehash` after

## Acceptance

- [ ] CLI emits `plan_invocation`: emit key flipped in `plugins/plan/src/emit.ts` + trailer sites in `cli.ts`/`validate.ts`
- [ ] 111 `planctl_invocation` refs across 22 files under `plugins/plan/test/` migrated to `plan_invocation`
- [ ] `bun run promote` rebuilds `dist/planctl-bun` + atomically replaces `~/.local/bin/planctl`; `test/plan-shim.test.ts` green
- [ ] soak clean (first-hour init->scaffold->claim->done->close cycle in a scratch repo) per plugins/plan/CLAUDE.md; rollback target known
- [ ] the `planctl_invocation` reader retained (historical-event compat)
