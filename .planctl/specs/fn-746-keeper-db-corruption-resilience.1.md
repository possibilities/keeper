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

## Evidence
