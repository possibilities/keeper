## Description

**Size:** M
**Files:** src/daemon.ts, test/zellij-events-worker.test.ts

### Approach

Replace the oversize `continue`-skip in `scanZellijEventsDir`
(`daemon.ts:804-809`) with a bounded tail-read so an over-cap feed degrades
to "tail-only" instead of "frozen forever." Compute
`tailBase = max(priorOffset, st.size - MAX_ZELLIJ_EVENTS_FILE_BYTES)`; read
the buffer from `tailBase` (byte-indexed `subarray`, never a JS-string
slice — the multi-byte gotcha at `:836-847`). When `tailBase > priorOffset`
(we jumped past unconsumed bytes), the window starts mid-line: discard bytes
up to the first `\n` and count them as `discardedPartialBytes`. Seed
`sessionEpoch` from the FIRST successfully parsed line in the window so a
stale persisted epoch can't mis-trigger the reset path. Walk forward exactly
as today (defer the trailing partial). Compute the new watermark as
`newOffset = tailBase + discardedPartialBytes + consumedBytesInTail` — NOT
the existing `priorOffset + consumedBytesInTail` (`:988`), which assumes
`base == priorOffset`. Export `MAX_ZELLIJ_EVENTS_FILE_BYTES` (`:608`) so a
test can drive an oversize file at a small injected size. Preserve:
never-throw (swallow to stderr + continue), the no-clobber empty-`tab_name`
skip (`:896-902`), the single atomic watermark persist at scan end, and the
`BackendExecSnapshot` mint through `stmts.insertEvent`. Dropping intermediate
deltas is safe — both consumers (tab-namer rename, autopilot reap) are
last-writer-wins on per-pane facts and the latest line carries current
`tab_id`. This change is event-sourcing-clean: `scanZellijEventsDir` mints
synthetic events producer-side, it is not a fold (no re-fold-determinism
concern), but keep it free of new wallclock/env reads.

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:804-820 — the cliff + `priorOffset` clamp + shrink guard
- src/daemon.ts:822-902 — byte-slice + forward line walk + epoch-reset detect (`:891-894`)
- src/daemon.ts:987-1001 — watermark advance arithmetic (the base assumption to fix)
- src/daemon.ts:608, 603-606 — the cap const (export it) + the superseded skip comment (prune)
- test/zellij-events-worker.test.ts:258-316 — epoch-reset test + seedJob/makePaneEvent/readBackendExecEvents harness

**Optional**:
- src/zellij-events.ts:98-176 — `parseZellijEventLine` (returns null for sentinel/garbage — affects epoch seeding off the first line)

### Risks

- Mid-file resync is genuinely new — today the tail always starts at a line boundary. Get the `discardedPartialBytes` accounting exactly right or the watermark corrupts.
- The first parsed line in the window may be `null` (a `plugin_start` sentinel or garbage) — epoch seeding must walk to the first non-null parse, not assume line 0 parses.
- `MAX_ZELLIJ_EVENTS_FILE_BYTES` is currently unexported and no oversize test exists; exporting it is a prerequisite for the test.

### Test notes

Add a test to `test/zellij-events-worker.test.ts`: build a feed larger than
the (exported/injected) cap, scan, and assert the latest pane's snapshot
mints, the watermark advances to a tail-base-relative offset, and re-scan is
idempotent. Assert the oversize path no longer emits the `exceeds…skipping`
stderr. Also: README ninth-worker description + the `daemon.ts:603-606`
comment updated to "tail-read instead of skip."

## Acceptance

- [ ] Oversize feed is tail-read from `max(priorOffset, size-CAP)`, not skipped; partial leading line discarded to the next `\n`.
- [ ] Watermark advances from the actual window base (`tailBase + discardedPartialBytes + consumedBytesInTail`); re-scan is idempotent.
- [ ] `sessionEpoch` seeded from the first parsed line in the window; stale persisted epoch does not mis-trigger.
- [ ] `MAX_ZELLIJ_EVENTS_FILE_BYTES` exported; an oversize tail-read test added and green.
- [ ] Never-throws; no-clobber empty-`tab_name` preserved; single atomic watermark persist preserved.
- [ ] README ninth-worker doc + superseded `daemon.ts` comment updated.

## Done summary

## Evidence
