## Overview

Under concurrent-worker load the daemon got slow in two visible ways during the
2026-06-08 session: folds took up to 5.4s, and the board/jobs subscribe-server
TUI was slow to CONNECT and late to UPDATE. Scale: ~602k events, 868 epics, a
~1.26MB epics-projection snapshot. This is the SERVE-side / under-load follow-on
to fn-737 (done — that covered plan-worker fold WAKE paths only, not serve-side
snapshot cost or fold throughput). Diagnostic-first: measure where the time
actually goes before pulling levers, then apply the smallest proven lever(s).

Known levers from recon (to confirm/measure, not assume): the cold subscribe
re-serializes the full 1.26MB snapshot on a memo miss (`serveFromMemo`,
server-worker.ts:597); `diffTick` already version-probes and fetches only
changed rows (server-worker.ts:1973-2080) so deltas partly exist; Bun
`postMessage(string)` has a ~500x fast path vs structured-clone for large
payloads; per-row version deltas avoid full re-serialize; WAL checkpoint cadence
affects read latency on a 600k-event log. The fold side (drain loop / applyEvent
over the big log) is the other half.

INVARIANTS: cursor+projection advance in ONE `BEGIN IMMEDIATE`; batches stay
short so hook INSERTs aren't starved; re-fold determinism untouched; no kernel
watchers on keeper's own DB (`data_version` poll + kick stays).

## Quick commands

- `bun test test/server-worker.test.ts test/reducer.test.ts`
- controlled load harness (built in `.1`): concurrent subscribers + fold burst,
  measure connect p95, update-latency p95, fold p95
- `bun test`

## Acceptance

- [ ] Before/after p50/p95 for: cold subscribe-connect time, board update
  latency under a fold burst, and per-fold latency on the live-size log — from a
  controlled harness built in `.1`.
- [ ] The dominant cost is identified and the applied lever measurably improves
  its p95 (single-digit-seconds connect; sub-second updates under normal load).
- [ ] Cursor+projection single-transaction, short batches, re-fold determinism,
  and the `data_version`-poll/kick contract are all unchanged.

## Early proof point

Task `.1` (diagnose + harness) decides which lever `.2` pulls. If `.1` shows the
dominant cost is NOT addressable by a safe serve/fold lever (e.g. it's
fundamentally the 1.26MB snapshot size and only a schema/projection reshape would
help), STOP and re-scope — that's a larger decision, not this epic.

## References

- Incident: `~/docs/keeper-incident-2026-06-08-continuity.md` (5.4s folds, slow TUI connect).
- fn-737 (plan-worker fold-latency — done; this is the serve-side follow-on, read
  its spec to avoid overlap).

## Best practices

- **Send a full snapshot once on subscribe, then row-level deltas** — don't
  re-serialize 1.26MB every fold cycle. `diffTick` already has the version-probe
  primitive to build on. [practice-scout]
- **Bun `postMessage(string)` fast path** (~500x): the JSON string must be the
  TOP-LEVEL message, not wrapped in `{kind, data}`. [practice-scout, Bun 1.2.21+]
- **Per-row version (`updated_at`/rowid) deltas, not `JSON.stringify`-equality
  diffing** — insertion order isn't a safe equality key. [practice-scout]
- **`PRAGMA wal_checkpoint(PASSIVE)` on cadence** — a large WAL degrades read
  latency. Separate RO poller connection for `data_version` (same-conn writes
  don't bump it). [practice-scout]
