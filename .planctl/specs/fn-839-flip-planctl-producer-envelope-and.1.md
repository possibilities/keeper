## Description

**Size:** M
**Files:** plugins/plan/src/emit.ts, plugins/plan/src/cli.ts, plugins/plan/src/validate.ts, plugins/plan/test/ (22 files), src/reducer.ts (reader — DO NOT TOUCH)

### Approach

SUPERVISED — human in the loop for the promote (touches live ~/.local/bin/planctl).
(1) Flip emit key `planctl_invocation`->`plan_invocation` in plugins/plan/src/emit.ts
plus the consistent trailer sites in cli.ts/validate.ts. (2) Migrate the 111
`planctl_invocation` refs across 22 files in plugins/plan/test/ to `plan_invocation`.
(3) `bun run promote` (rebuild dist/planctl-bun + atomic replace of the live binary),
then run the soak + watch the first-hour rollback triggers per plugins/plan/CLAUDE.md.
Leave the `planctl_invocation` reader in src/reducer.ts untouched (historical events).

### Investigation targets

**Required** (read before coding):
- ~/half-b-planctl-producer-promote.md — full handoff context for this split
- test/plan-shim.test.ts — asserts source<->compiled-binary byte parity (why promote is forced)
- plugins/plan/CLAUDE.md — promote / soak / rollback protocol

## Acceptance

- [ ] CLI emits `plan_invocation`; 111 refs / 22 files migrated; promote + soak clean; reader retained

## Done summary

## Evidence
