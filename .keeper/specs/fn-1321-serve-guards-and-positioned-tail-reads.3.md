## Description

**Size:** M
**Files:** src/daemon.ts, test/events-ingest-worker.test.ts

### Approach

The events-log scan reads and decodes each per-pid NDJSON file in full
every tick, then slices at the durable offset — O(file) forever on
files that only grow. Replace the whole-file read with a positioned
read of only the unread range: open the file, fstat THE OPEN FD and
reconcile that identity against the stat'd inode the offset row is
keyed on (a path replaced between stat and open must not attribute new
bytes to the old inode's row), read from the stored byte offset capped
at the fstat'd size, LOOP on short reads until the range is complete
or EOF, and close the fd in a finally. All existing semantics are
invariants to preserve, and their tests exist: torn-tail bytes after
the last newline never advance the offset; a size below the stored
offset resets to zero (truncation/replacement); offsets stay BYTE
counts advanced by bytes consumed (never string length); each line
reaches the frozen-signature line parser as a string; and the offset
upsert stays inside the one BEGIN IMMEDIATE with the INSERTs — the
read I/O completes and the fd closes BEFORE the transaction opens,
and a read failure skips the file without advancing. The byte-parity
regression (NDJSON-ingested event equals a direct INSERT byte-for-byte)
must stay green. The known inode-reuse limitation of (path, inode)
keying stays a documented limitation — no fingerprinting creeps in.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:5971-6222 — scanEventsLogDir end to end: statSync :6011, offset row read :6029, whole-file read :6053 (the site to replace), byte-view slice :6062-6065, truncation guard :6036-6038, torn-tail exclusion :6116-6124, the atomic tx :6126-6198
- test/events-ingest-worker.test.ts — the ~40-case suite this extends: byte-parity :353, truncation :422, torn tail :314, poison :492/:671, append-after-scan :285
- src/dead-letter.ts:289 — parseEventLogLine (FROZEN signature; feed it strings)

**Optional** (reference as needed):
- src/events-ingest-worker.ts — the watcher that nudges (never reads/inserts); unchanged

### Risks

- An fd leaked per file per tick exhausts descriptors over the daemon's lifetime and no small-file test reproduces it — the finally-close needs its own test
- A short read treated as complete truncates mid-line and stalls or drops — loop until range-complete or EOF, with a test forcing a partial read through the seam
- Growth between stat and read: cap at the fstat'd size (next tick catches growth) so torn-tail evaluation stays consistent with the read boundary

### Test notes

Extend the existing suite in place: positioned-read equivalence over
every existing case (the suite already covers the semantics — it now
exercises the new path), plus fd-lifetime, short-read looping (through
an injected read seam if needed), and stat-then-open identity
mismatch (replaced file between stat and open → no offset corruption).

## Acceptance

- [ ] A scan tick reads only the unread byte range of each file; folded output is byte-identical to the whole-file path (the parity regression stays green)
- [ ] The open fd's identity is reconciled with the offset row's inode; a file replaced between stat and open never corrupts another row's offset
- [ ] Short reads are looped to completion, the fd always closes, and a read failure skips the file without advancing its offset
- [ ] Torn-tail, truncation-reset, poison-line, and byte-offset semantics are unchanged; the full fast correctness gates stay green

## Done summary

## Evidence
