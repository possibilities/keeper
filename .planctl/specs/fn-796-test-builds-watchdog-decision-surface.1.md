## Description

Originating finding F2 (Should Fix). Evidence: `babysitters/builds/watchdog.ts`
exposes pure injectable `decideWatchdog`, `readHeartbeatTs`,
`readLastAllClearDay`/`writeLastAllClearDay`, and `utcDay`; the precedent
`test/keeper-watchdog.test.ts` exists and imports the performance sitter's
watchdog the same way, while `test/builds-watchdog.test.ts` is confirmed
missing. `test/babysitter-build.test.ts:48` only smoke-imports the file for the
import-pin and asserts no behavior. This watchdog is the sitter's only
notification surface, so its branches are the most load-bearing logic in the
epic and ship untested.

Add `test/builds-watchdog.test.ts` mirroring `keeper-watchdog.test.ts`: assert
`alarm` past `WATCHDOG_STALE_SECS`, `first-run` on a null heartbeat, `all-clear`
on a new UTC day, `ok` (silent) same-day, `readHeartbeatTs` corrupt-and-missing
→ null, and the day-marker write/read round-trip. Pure functions — inject now /
heartbeat-read / last-all-clear-day; no real botctl or clock.

## Acceptance

- [ ] `decideWatchdog` asserted across all four actions (alarm / first-run / all-clear / ok)
- [ ] `readHeartbeatTs` returns null on both missing and corrupt files
- [ ] day-marker `writeLastAllClearDay`/`readLastAllClearDay` round-trip asserted
- [ ] Test runs in the same tier as `test/keeper-watchdog.test.ts` and passes

## Done summary

## Evidence
