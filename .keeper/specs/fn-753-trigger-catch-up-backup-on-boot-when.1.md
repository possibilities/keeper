## Description

Finding F3 (`src/daemon.ts:3596–3630`): the backup timer is
`setInterval(..., BACKUP_INTERVAL_MS)` with no boot-time check. If keeperd
restarts more often than every 24h (via LaunchAgent after a crash), the
automatic backup floor silently never fires.

In `src/daemon.ts`, before wiring the regular `setInterval`, check the age of
the newest snapshot: list `resolveBackupDir(dbPath)`, filter for the
`/^keeper-\d{8}T\d{6}\.db$/` pattern, take the lexically-last (newest) name,
and parse its `YYYYMMDDTHHMMSS` stamp. If `Date.now() - snapshotTs >=
BACKUP_INTERVAL_MS` (or no snapshots exist), schedule a one-shot `setTimeout`
with a short startup delay (e.g. 30–60s) that runs the same backup callback
before the regular interval begins. Clear the timeout in the shutdown handler
alongside `clearInterval(backupTimer)`. The catch-up path must share the
full never-throw / log-on-failure / page-on-failure contract of the regular
callback.

## Acceptance

- [ ] On boot with no prior snapshot: catch-up fires within the startup delay.
- [ ] On boot with a snapshot older than `BACKUP_INTERVAL_MS`: catch-up fires within the startup delay.
- [ ] On boot with a fresh snapshot: no catch-up fires; regular timer behavior is unchanged.
- [ ] Shutdown clears the one-shot timeout before it fires if the daemon stops within the delay window.
- [ ] Tests cover the three boot-state cases (no snapshots, overdue, fresh).

## Done summary
Added boot-time catch-up backup: daemon checks newest snapshot age on boot and schedules a one-shot VACUUM INTO via setTimeout when overdue (or no snapshot exists), cleared in shutdown. New pure helpers newestSnapshotMs/isCatchUpDue in backup.ts; tests cover no-snapshot, overdue, and fresh cases.
## Evidence
