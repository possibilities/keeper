## Overview

The git-worker emits `GitSnapshot` events at ~13-20/sec sustained (max
1191/min observed) whenever any watched repo has actively-churning dirty
files — i.e. whenever a worker session is editing. Each fold is expensive
(0.2-1.7s), so the flood saturates the single-writer reducer drain and the
board / autopilot read stale projections. Two producer-side defects cause
it, both in `src/git-worker.ts`: (1) the no-op dedupe key is
`JSON.stringify(snapshot)` which embeds per-file `mtime_ms` + `worktree_oid`,
so any mtime/oid churn defeats it; (2) the `data_version` poll re-schedules
EVERY subscribed root on every DB bump, and the worker's own GitSnapshot
insert bumps `data_version` — a self-feeding loop. This epic throttles
emission to ≤1 snapshot per root per ~1-2s (latest-wins), makes the dedupe
key semantic (mtime/oid stay in the payload, out of the key), and narrows
the wake so a bump only re-schedules genuinely-affected roots. All changes
live entirely at the producer; the reducer never sees them, so re-fold
determinism is preserved.

## Quick commands

- `bun test test/rescan.test.ts test/git-worker.test.ts`
- `bun scripts/bench-latency.ts` — before/after hook→projection latency
- Live check: `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT (MAX(ts)-MIN(ts))/60000.0 FROM (SELECT ts FROM events WHERE hook_event='GitSnapshot' ORDER BY id DESC LIMIT 1000);"` — span of last 1000 GitSnapshots should widen dramatically (fewer per minute)

## Acceptance

- [ ] Under simulated continuous churn, a single root emits ≤1 GitSnapshot per throttle window (test-pinned), not one per poll
- [ ] A dirty-file mtime/oid change with no render-significant change (same path/status/mode/content-oid set, branch, ahead/behind) does NOT produce a new GitSnapshot event
- [ ] The `data_version` wake no longer re-schedules every subscribed root on every bump — only newly-subscribed / membership-changed / genuinely-affected roots
- [ ] `mtime_ms` and `worktree_oid` remain present in the emitted GitSnapshot payload (reducer pass-2 inferred attribution + content-aware discharge still work)
- [ ] The `snapshotSuppressedByDivergence` wedge guard still fires on the live path (throttle must not bury it)
- [ ] A from-scratch re-fold over a pre-change event log reproduces byte-identical projections (throttle/key are producer-only)
- [ ] Coalesced-drop count is logged so the flood reduction is observable

## Early proof point

Task that proves the approach: `.1` (RescanScheduler max-wait ceiling). If a
pure trailing-edge debounce can't bound staleness under continuous churn, the
whole throttle approach needs a leading/max-wait cap — prove it in the
scheduler primitive first, with the fake-clock harness, before wiring it into
the git-worker.

## References

- `src/git-worker.ts:2177` dedupe key; `:2186` schedulerFor seam; `:2028`/`:2213` emitSnapshot + wedge guard; `:2537-2547` data_version poll re-scheduling every root; `:1861` buildGitSnapshot (mtime/oid stamping)
- `src/rescan.ts:103` RescanScheduler — trailing-edge debounce ONLY (DEFAULT_DEBOUNCE_MS=500), no max-wait today; shared with transcript-worker + plan-worker drop-recovery (don't regress their trailing-only contract)
- `test/rescan.test.ts` fake-clock harness (pendingCount/flush via injected SchedulerTimers); `test/git-worker.test.ts` buildGitSnapshot unit tests

## Best practices

- **Latest-wins sampler, not bare trailing debounce:** a trailing-only debounce can re-arm forever under continuous load and never fire — bound it with a max-wait/leading cap so staleness has a ceiling.
- **Semantic dedupe key, never a payload hash:** key on what changed (project, head/upstream/ahead/behind, per-file path/status/mode/content-oid), never on timestamps/mtime — those make every event unique and silently disable coalescing.
- **data_version self-write guard:** gate the wake on an actual version advance the worker didn't cause, plus a min-elapsed floor; don't reschedule all roots on every bump.

## Snippet context

No bundle/snippets attached: searched scout mentions and the keeper repo has
no promptctl snippet corpus for git-worker/rescan internals — the spec's
file:line refs are the durable context.
