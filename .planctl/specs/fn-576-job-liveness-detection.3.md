## Description

**Size:** S
**Files:** plugin/hooks/events-writer.ts, test/events-writer.test.ts

### Approach

Inside the existing SessionStart-only branch where `spawnNameFromPpid` runs (`plugin/hooks/events-writer.ts:120-146`), capture `start_time` alongside the name. On Darwin, fold into the SAME ps fork — change `-o args=` to `-o args=,lstart=` (one shell-out captures both fields; parse columns). On Linux, read `/proc/$PPID/stat` and extract field 22 (no fork). Wrap in try/catch returning null. Result feeds the `insertEvent` call (column added in task 1) as a platform-tagged opaque string (`darwin:<lstart-text>` or `linux:<jiffies>`). Never interpreted cross-platform.

### Investigation targets

**Required** (read before coding):
- `plugin/hooks/events-writer.ts:120-146` — `spawnNameFromPpid` precedent (the ps shell-out pattern with `Bun.spawnSync` 500ms timeout, try/catch returning null)
- `plugin/hooks/events-writer.ts:174-222` — events-row insert; SessionStart gate at ~line 175
- `test/events-writer.test.ts:34-82` — spawn-launcher test pattern that provides stable parent ppid

**Optional**:
- `plugin/hooks/events-writer.ts:14-15` — file header comment on pid field semantics

### Risks

Hook 1.5s budget on SessionEnd — start_time capture must stay SessionStart-only (free, already shelling). On macOS, the combined `-o args=,lstart=` must still parse the existing `args=` reliably (lstart is a fixed-width 24-char field; verify the existing args-parser still works with the new column appended). Hook MUST exit 0 — try/catch around the parse path; failure returns null.

### Test notes

Extend the spawn-launcher test to verify both `name` and `start_time` come back populated and platform-tagged correctly. On a force-failure path (broken ps), verify the hook still returns 0 and the event row has `start_time=null`.

## Acceptance

- [ ] On macOS, single ps fork on SessionStart captures both `args` and `lstart`; parser handles the dual-field output
- [ ] On Linux, `/proc/$PPID/stat` field 22 read returns `linux:<jiffies>` (no fork)
- [ ] Capture failure returns null without throwing; hook exits 0
- [ ] Captured value is platform-tagged opaque string; never interpreted cross-platform
- [ ] Hook header comment updated to document (pid, start_time) two-field identity

## Done summary

## Evidence
