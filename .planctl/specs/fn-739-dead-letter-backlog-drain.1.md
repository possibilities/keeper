## Description

**Size:** M
**Files:** `src/dead-letter.ts`, `src/daemon.ts` (replay path, read-only
review), drain tooling under `~/.local/state/keeper/`, optionally a
`scripts/` report helper, `test/` for idempotent-replay coverage.

### Approach

1. **Characterize the backlog (read-only first).** Count and size the
   backlog; parse a sample to confirm record shape (`parseDeadLetterLine`).
   Extract the dominant `hook_event` / time distribution and — crucially —
   whether any record carries a failure reason; if not, correlate the dead-
   letter window (May 29 → Jun 7) with WAL-contention evidence to
   confirm/deny the `SQLITE_BUSY` hypothesis. Write the finding into the
   Done summary.

2. **Drain safely + idempotently** via the sanctioned `replay_dead_letter`
   path (MAIN-only writer). Verify each replayed record lands as exactly one
   `events` row (no duplicates on re-run — the replay path must be idempotent
   or made so). A torn final line must be skipped (parser returns null), not
   replayed. Only after rows are confirmed landed, remove (or archive) the
   drained per-pid files.

3. **Re-fold parity.** A replayed event must fold byte-identically to one
   that landed directly (all columns incl. SessionStart-scraped fields) —
   the re-fold determinism invariant. Add/extend a test proving replay
   idempotency + parity if not already covered.

4. **Record baseline + sequencing note.** Capture a post-drain count
   baseline and state explicitly that the "stays at zero" re-measure happens
   AFTER fn-736's hook flip is deployed (the structural fix for the cause).

### Investigation targets

**Required:**
- `src/dead-letter.ts` — `serializeDeadLetterRecord`, `parseDeadLetterLine`
  (null on partial/garbage)
- `src/daemon.ts` — `replay_dead_letter` RPC handler, `dead_letters` sidecar,
  boot dead-letter scan (`scanDeadLetterDir` ~:503-613)
- `src/dead-letter-worker.ts` — per-pid dir watch → hint → MAIN scan+write
- existing `~/.local/state/keeper/deadletter-drain.{sh,ts}` + log (reuse if sound)

### Risks

- Data safety: NEVER delete a per-pid file before its rows are confirmed
  landed. Idempotent replay only — re-running must not duplicate rows.
- Sole-writer: replay is MAIN-only; no direct DB write, no synthetic event
  from a CLI/script.
- Re-fold determinism: replayed rows must reproduce byte-identical projections.
- Do not change the hook fail-open contract (that's fn-736's domain).
- This task does NOT touch the in-flight fn-736 worktree.

### Test notes

- Idempotent-replay test: replay the same record twice → exactly one row.
- Torn-tail test: a partial final line is not replayed.
- `sandboxEnv(...)` covering `KEEPER_DEAD_LETTER_DIR` + the other state paths.

## Acceptance

- [ ] Backlog drained with zero row loss; replay idempotent (re-run → no dups).
- [ ] Files removed/archived only after rows confirmed landed; post-drain
  baseline recorded.
- [ ] Dominant failure cause reported (confirm/deny SQLITE_BUSY → fn-736).
- [ ] Re-fold parity test green; hook fail-open contract unchanged; no direct
  DB write.

## Done summary

## Evidence
