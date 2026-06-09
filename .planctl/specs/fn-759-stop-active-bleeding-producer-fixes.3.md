## Description

**Size:** S
**Files:** src/transcript-worker.ts, test/transcript-worker.test.ts, README.md

### Approach

Add a per-path `{size, mtimeMs}` stat memo to the transcript scan path so the 60s
heartbeat (and the FSEvents-drop rescan) skips unchanged files instead of
re-reading ~733MB/min end-to-end. The gate lives INSIDE `scanFile` (the natural
seam — it already statSync's for size), so the caller's rescued-OR accounting in
`scanJobsForTitles` and the fn-720 `backstopCounters.bump` flow are untouched.

Memo rules:
- A NEW private `Map<string, {size: number, mtimeMs: number}>` — explicitly
  SEPARATE from `pathState` (the live-tail offset memo); scanFile's documented
  contract ("transient full-read, never touches pathState", :482-486) stays true,
  with the memo as the ONLY new state it writes.
- Skip condition: `size === memo.size && mtimeMs === memo.mtimeMs` -> `return false`
  (flows into the existing no-emit/rescued=false path).
- `size < memo.size` (truncation/rotation) -> treat as changed, rescan from 0.
- Capture the stat BEFORE the read; write the memo entry only AFTER a successful
  stat AND a successful full scan (a transient EACCES/EIO must never poison the
  memo into permanently suppressing a file). A mid-read append is then caught
  next tick (pre-read stat is conservative).
- ENOENT: keep the existing cheap early-return; DELETE any memo entry for the
  path (so an un-vanished file is always re-scanned). Do not cache "gone".
- In-memory only — no sidecar, no persistence. Bounded by jobs.transcript_path
  cardinality, no eviction; document that bound and the append-only assumption
  ("transcripts only grow; same-size in-place rewrite would defeat size+mtimeMs
  — acceptable because no writer does that") in a comment at the memo.
- Do NOT scope the jobs SELECT to non-terminal jobs — the memo alone delivers the
  win with identical rescue semantics (no gold-plating).

Update README.md transcript-producer prose (~1194-1209) with one sentence on the
heartbeat memo.

### Investigation targets

**Required** (read before coding):
- src/transcript-worker.ts:500-525 — scanFile: the statSync seam, ENOENT/size<=0 early-returns
- src/transcript-worker.ts:374-403, 482-486 — pathState and the contract keeping scanFile transient
- src/transcript-worker.ts:876-896 — scanJobsForTitles: the per-row scanFile loop and rescued OR
- src/transcript-worker.ts:1040-1075 — heartbeat body + backstopCounters.bump (must stay intact)
- test/transcript-worker.test.ts:348-380 — the unchanged-file drop-recovery test shape to extend

### Risks

- Memo poisoning via failure-path writes (covered by write-only-after-success rule).
- Lifting the gate into scanJobsForTitles with a `continue` would bypass the
  rescued OR — keep it inside scanFile.

### Test notes

Extend the :348-380 shape: (a) second scan of an unchanged file performs zero
reads (spy/instrument the read path) and emits nothing; (b) appended file rescans
and emits; (c) truncated file rescans from 0; (d) stat failure leaves the memo
entry absent/stale so the next healthy tick rescans; (e) ENOENT clears the entry.

## Acceptance

- [ ] unchanged files are skipped without reading any bytes (spy test); changed/truncated files still scan correctly
- [ ] memo is a separate map from pathState; written only after successful stat+scan; ENOENT clears it
- [ ] rescued accounting / backstopCounters.bump call sites byte-untouched
- [ ] README transcript prose updated; full `bun test` green

## Done summary

## Evidence
