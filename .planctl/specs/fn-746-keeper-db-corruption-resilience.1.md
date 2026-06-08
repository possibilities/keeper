## Description

**Size:** M
**Files:** cli/keeper-watchdog.ts OR src/daemon.ts (integrity timer), src/compaction.ts (read), test/ (new), scripts/ (probe harness)

### Approach

Two parts. (1) DIAGNOSE the 2026-06-07 `malformed`+segfault: inspect the WAL
checkpoint state/cadence on the ~2 GB DB (is the WAL growing unchecked? is
`wal_autocheckpoint` set?), whether cold-blob compaction (src/compaction.ts) is
keeping pace with growth or the DB is growing unbounded, and the concurrent-
access pattern around the segfault (confirm every worker opens its OWN
connection — worker contract — and main is sole writer; a shared/torn handle is
the prime suspect). Capture findings in the Done summary. (2) ADD DETECTION: a
low-overhead periodic `PRAGMA quick_check` on a read-only connection that pages
on failure via the existing notify/backstop path. Put it in the standalone
`cli/keeper-watchdog.ts` (dependency-free dead-man) or a low-frequency
daemon-side timer — NOT `cli/keeper-watch.ts` (fn-745 owns it right now). Keep
the probe cheap (quick_check, not integrity_check; low cadence; read-only conn;
no long lock on the 2 GB DB).

### Investigation targets

**Required:**
- daemon stderr lines for `database disk image is malformed` / `Segmentation
  fault` (2026-06-07 ~02:07) — the incident
- src/daemon.ts — WAL/pragma setup at openDb, the periodic-timer pattern
  (pending-dispatch sweep, compaction timer), checkpoint calls if any
- src/compaction.ts — cold-blob relocation (size-management; is it keeping pace?)
- cli/keeper-watchdog.ts — standalone dead-man (candidate monitoring home + its test)
- src/db.ts openDb — connection/pragma config (WAL, busy_timeout, autocheckpoint)

### Risks

- quick_check must not hold a long read lock or starve the writer on a 2 GB DB —
  keep cadence low + read-only conn.
- Probe is read-only/producer-side; never inside a fold (re-fold determinism).
- Stay OFF keeper-watch.ts (fn-745 overlap) — use watchdog / daemon timer.
- Don't change fold/cursor/sole-writer semantics.

### Test notes

- Pin: a deliberately-corrupted fixture DB trips the probe + pages; a healthy DB
  does not. Probe is read-only and bounded.

## Acceptance

- [ ] Periodic quick_check probe pages on corruption, read-only, low-overhead;
  a healthy DB never false-pages.
- [ ] Diagnosis of the malformed+segfault (WAL/checkpoint, compaction pace,
  connection-sharing) written to the Done summary with the chosen mitigations.
- [ ] Monitoring lives off keeper-watch.ts; no fold/determinism/sole-writer change.

## Done summary
DETECTION: added a producer-side periodic PRAGMA quick_check probe (src/integrity-probe.ts) on a dedicated short-lived READ-ONLY connection, wired on a 15min daemon heartbeat beside the WAL/compaction timers (cleared on shutdown). Read-only never takes the writer lock, so it cannot starve the sole writer or a hook INSERT; producer-side, no fold/cursor/sole-writer change; monitoring stays OFF keeper-watch.ts. Pages via botctl (Keeper topic) on a non-ok row OR a SQLITE_CORRUPT throw -- KEY FINDING: bun:sqlite RAISES 'database disk image is malformed' while stepping quick_check (the exact 2026-06-07 surface) rather than returning a non-ok row, so the probe classifies a corruption throw as a positive page signal (isCorruptionThrow) and only benign throws as non-fatal retry. Healthy probe is silent; never-throws. 13 unit/e2e tests incl a corrupted-fixture PIN.

DIAGNOSIS of the 2026-06-07 malformed+segfault (live ~1.9GB DB, quick_check=ok, 610k events): (1) WAL is NOT the culprit -- WAL only 396KB, wal_checkpoint=0|90|90 (all frames checkpointed, 0 busy); the fn-744.2 30s PASSIVE checkpoint heartbeat + wal_autocheckpoint=1000 are keeping WAL bounded. (2) Compaction IS keeping pace -- 605157/610202 blobs relocated to event_blobs (~1.49GB moved out of the hot table), only 5045 inline (~35MB == RECENT_RETENTION_MARGIN window + trickle); cold backlog fully drained. (3) Connection-sharing: each worker opens its OWN connection per the worker contract and main is sole writer (daemon opens one writer at db.ts:6142; RO poller is a separate worker conn) -- no shared/torn handle found in code. The residual risk is the 1.9GB FILE SIZE itself (page_count 499857; freelist only 215 -- online VACUUM is deliberately deferred per compaction.ts, so the file stays large after relocation), which widens the blast radius of any single bad page and is the prime contributor to the one-off malformed read. MITIGATIONS for .2: offline VACUUM/size reclamation + a backup/snapshot+restore path (the file-size lever, not WAL). The segfault is most likely the native fault path bun:sqlite takes when stepping a malformed B-tree page under load -- the new probe converts that silent surface into a proactive page.
## Evidence
