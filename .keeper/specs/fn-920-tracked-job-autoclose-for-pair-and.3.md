## Description

**Size:** S
**Files:** cli/pair.ts, src/pair-command.ts, test/pair-cli.test.ts, test/pair-command.test.ts

### Approach

Make the claude path fire-and-forget and keep codex/pi synchronously reaped. In
`cli/pair.ts`, branch the reap on `cli`: claude → no synchronous `killWindow` (the
daemon reaper arm from task .2 now owns it); codex/pi → keep the existing synchronous
`killWindow` + SIGTERM reap. Remove `DEFAULT_PAIR_PERSIST_SESSIONS` and replace
`resolvePairPersistSessions` with a unified `disable-autoclose` resolver (config-key
sourced, default EMPTY) — read by the CLI for the codex path and (task .2) daemon-side
for the claude path, so operators have ONE knob. Drop the now-dead claude reap/persist
code.

### Investigation targets

**Required** (read before coding):
- cli/pair.ts:148-161 `killWindow`, :263 `shouldReap`, :270-282 `reap()`/SIGTERM, :367/:398 reap call sites.
- src/pair-command.ts:624-649 `DEFAULT_PAIR_PERSIST_SESSIONS`/`resolvePairPersistSessions` (replace with the unified resolver).
- test/pair-cli.test.ts (Monitor contract), test/pair-command.test.ts (resolver tests).

### Risks

- SEQUENCING: this MUST land after task .2 (the daemon arm) — removing the claude synchronous reap before the arm exists would leak claude windows. The dep enforces it.
- Keep the codex/pi synchronous reap intact — they're untracked, the daemon cannot reap them.

### Test notes

Update resolver tests to the `disable-autoclose` semantics (default empty). Assert the claude path does NOT synchronously reap and the codex path DOES; Monitor two-line `completed` contract preserved for both clis.

## Acceptance

- [ ] claude path no longer synchronously reaps; codex/pi still do.
- [ ] `DEFAULT_PAIR_PERSIST_SESSIONS` removed; unified `disable-autoclose` resolver (default empty) in place, shared CLI + daemon.
- [ ] codex windows do not leak; a `disable-autoclose` session is honored CLI-side for codex.
- [ ] Monitor two-line `completed` contract unchanged for both clis.

## Done summary

## Evidence
