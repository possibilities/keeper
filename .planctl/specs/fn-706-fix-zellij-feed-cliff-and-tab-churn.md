## Overview

Keeper tab-renaming silently dies for an entire zellij session once that
session's NDJSON feed (`~/.local/state/keeper/zellij-events/<session>.ndjson`)
crosses the 16 MiB cap: `scanZellijEventsDir` `continue`-skips the whole file
every scan forever, the watermark freezes, no `BackendExecSnapshot` mints,
`jobs.backend_exec_tab_id` stays NULL, and the tab-namer-worker never renames
(it filters `backend_exec_tab_id IS NOT NULL`). Confirmed live: a 21 MB
`control` feed tripped the skip; hand-truncating it unblocked renaming —
that manual truncate is the recurring mole.

Two root causes, three moves. Correctness is priority #1; churn/disk
reduction is folded in because we're already in the code.

- **Move 1 (correctness, load-bearing):** tail-read the last window of an
  oversize feed instead of skipping it — a noisy session degrades to
  "tail-only," never "frozen." Stands alone and lands first.
- **Move 2 (disk hygiene):** plugin-side live-feed rotation
  (truncate + fresh-epoch header + full re-snapshot) so the file never grows
  unbounded, plus consumer-side rotation detection via a cheap first-line
  epoch peek.
- **Move 3 (cheap churn):** a process-name debounce in the separate
  `zellij-tab-namer` plugin so transient process flaps (`[starship]`,
  sub-second subprocesses) stop generating real renames → real TabUpdates →
  feed lines.

End state: tab names reliably converge from the launch label to the session
title and follow drift; the feed self-bounds well under the cap; the
oversize tail-read remains a never-frozen safety net.

## Quick commands

- `bun run test test/zellij-events-worker.test.ts` — consumer tail-read + rotation tests
- `(cd plugin/zellij-bridge && cargo test)` — bridge pure-fn tests (rotation gate)
- `tail -f ~/.local/state/keeper/server.stderr | grep -i 'exceeds.*skipping'` — must stay silent post-fix
- `wc -c ~/.local/state/keeper/zellij-events/*.ndjson` — live feeds stay well under 4 MB
- start a fresh `claude` session in zellij, watch the tab go default → session title (not stuck on `[python]`) within ~1-2s

## Acceptance

- [ ] An oversize feed is tail-read, not skipped: `BackendExecSnapshot` mints resume, watermark advances, no `exceeds…skipping` stderr.
- [ ] The bridge rotates its own feed at the threshold (truncate + epoch-bump + full re-snapshot in one write); the consumer detects rotation via a first-line epoch peek and re-resolves every live pane's `tab_id`.
- [ ] `zellij-tab-namer` suppresses a process name that does not persist N consecutive ticks; a stable process still names the tab; the disown/ownership model is unchanged and its existing tests pass.
- [ ] No DB schema bump (no `keeper/api.py` change); event-sourcing invariants (no wallclock/env/fs in folds, sole-writer, never-throw scan) preserved.
- [ ] Both `.wasm` artifacts rebuilt + committed; CLAUDE.md + README updated.

## Early proof point

Task that proves the approach: `.1` (kill the cliff). It stands alone, is the
correctness unblock, and is verifiable against a synthetic oversize feed in
the test harness. If it fails: the hand-truncate stopgap still works and moves
2-3 are unaffected (they reduce the chance of ever hitting the cliff).

## References

- Live root-cause trace: 21 MB `control.ndjson` tripped `daemon.ts:804` oversize-skip; watermark frozen at `epoch:"1"`/16.77 MB; hand-truncate + manual `rename-tab-by-id` restored resolution.
- Closed history (stable, not in flight): fn-684 (zellij-events ingestion pipeline + bridge), fn-704 (diff-before-emit), fn-680/fn-699 (tab-namer worker). epic-scout: all 129 epics `done`, no open-epic deps/overlaps.
- The two plugins: keeper's bridge `plugin/zellij-bridge/src/main.rs` (feed emitter, correct diff gate) and the separate `~/code/zellij-tab-namer/src/main.rs` (1s poll, `[process]` renamer) — the churn source.
- Prior art (practice-scout): Fluent Bit (`size < offset` → reset), Filebeat filestream (commit `(epoch,0)` atomically with truncation detect or re-duplicate), Kafka idempotent producer `(id, epoch, seq)`.

## Docs gaps

- **CLAUDE.md carve-out (files) paragraph (~273-281)**: "one append-only `<session>.ndjson`" becomes append-only *within an epoch* — rotation truncates + bumps epoch; consumer watermark reset is the recovery path.
- **CLAUDE.md diff-before-emit fn-704.1 block (~367-384)**: add live-feed rotation as the second-layer churn defense; confirm it stays a single plugin write path (sole-writer intact).
- **README ninth-worker `scanZellijEventsDir` (~1735-1772)**: "tail-read instead of skip" on oversize; watermark resets on ANY epoch mismatch (reload OR rotation); a file shorter than the watermark is a rotation signal, not an error. Prune the superseded "skip + hand-truncate re-tail" comment at `daemon.ts:603-606`.
- **README eleventh-worker tab-namer (~1824-1854) + trace-flag section (~464-492)**: note the debounce relationship and post-fix expected trace rates.

## Best practices

- **Explicit epoch-header as the rotation signal, not size-shrink alone:** a behind-consumer + a re-snapshot that grows past the old offset defeats the `size < watermark` guard → mid-record garbage. Peek the first line's epoch each scan.
- **One `write_all` for header + snapshot:** O_APPEND atomicity is per-syscall; a split write lets the consumer observe a partial epoch transition.
- **WASI `O_APPEND`+`ftruncate` gotcha:** force the write position to 0 after truncate (explicit seek / re-open with `.truncate(true)`) — don't trust the runtime's append cursor, or you get a sparse zeros-hole feed.
- **Detect rotation by `st_size < watermark`, never inode** (truncate-in-place keeps the same inode); persist the `(epoch, offset)` tuple, not offset alone.
- **Tail-read:** seek to `max(0, size-CAP)`, discard the partial line to the next `\n` (one record lost, acceptable), parse complete lines only.

## Snippet context

No snippets/bundles attached. Searched promptctl for "event sourcing
watermark consumer offset", "rust wasm plugin build", and "log rotation
append-only file tail" — all empty. This is keeper-internal event-sourcing +
WASI-bridge architecture, not a shared cross-CLI pattern.
