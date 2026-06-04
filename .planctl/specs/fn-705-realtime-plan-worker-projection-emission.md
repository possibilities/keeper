## Overview

Plan/epic projection updates are bound by the plan-worker's 60s heartbeat
whenever its three edge-triggered fast paths (FSEvents callback, main's
`recheck-pending` post, the fn-681 `planctl-commit-changed` ingest) miss —
proven live: a close commit landed 14:10:59 but the `EpicSnapshot` didn't
fold until 14:11:45 (46s), gating an autopilot approve dispatch the
reconciler then served in <1s. The plan-worker is the ONLY projection
producer with no `PRAGMA data_version` poll; every other reader worker
polls at 25–50ms and is realtime. This epic makes plan/epic emission
realtime end to end: a fast `data_version` poll that drains the gated
`pending` set + change-gated re-ingest on every DB write (covers every repo
keeper knows about at ~50ms), a fix to the commit-ingest channel that drops
commits whose git enumeration threw, and a `.git/logs/HEAD` watch that
closes the brand-new/never-seen-repo tail where the in-HEAD transition has
no realtime trigger. The 60s heartbeat survives only as a should-never-fire
paranoia backstop.

## Quick commands

- `bun test test/plan-worker.test.ts test/git-worker.test.ts` — unit + worker integration
- `grep -c "backstop (heartbeat) emitted" ~/.local/state/keeper/server.stderr` — post-deploy, the loud alarm count should stop growing in normal operation
- Manual: run a planctl close, watch `keeper` board reflect the closed epic and autopilot dispatch the approver within a couple seconds, not ~45–60s

## Acceptance

- [ ] A plan/epic projection change that follows any keeper DB write surfaces in ~50ms, not up to 60s
- [ ] New epics (in keeper or any active repo) emit realtime via the poll + git-worker `.planctl`-short-circuit watch
- [ ] A brand-new epic scaffolded+committed in a repo keeper has never seen a session in emits realtime (no 60s wait)
- [ ] The fn-629 in-HEAD gate is preserved exactly — only git-proven-in-HEAD paths bypass; poll/recheck/FSEvents paths stay gated (no fn-627 regression)
- [ ] The 60s heartbeat (lowered) only ever fires for a genuinely abandoned uncommitted file; a backstop emit is a loud alarm, not normal operation
- [ ] Re-fold determinism preserved: the poll is a trigger only, never writes the DB nor drives a synthetic event from anything but a parsed `.planctl` file
- [ ] Worker contract honored: own read-only connection, single-flight coalescing, shutdown clears the poll timer before unsubscribe/close, no in-process self-heal

## Early proof point

Task that proves the approach: `T1` (the `data_version` poll). If close→approve collapses to ~50ms with the poll alone, the core thesis holds and the rest is reliability + tail-closing + docs. If it fails: the `data_version`/snapshot-read ordering or single-flight coalescing is wrong — fall back to mirroring the git-worker poll site line-for-line.

## References

- Canonical poll archetype (producer worker co-running poll + watcher + heartbeat): `src/git-worker.ts:2273-2301`, shutdown ordering `:2226-2259`
- Exported `watchLoop`: `src/wake-worker.ts:75-97`; single-flight to clone: `src/autopilot-worker.ts:1439-1486`
- fn-629 in-HEAD gate (load-bearing, fn-627 dup-dispatch guard) and the fn-681 commit-ingest channel
- Live evidence: `~/.local/state/keeper/server.stderr` `backstop (heartbeat) emitted ... — a fast path missed it` lines for fn-704/fn-703/fn-702

## Best practices

- **Poll `PRAGMA data_version` on the persistent read-only connection, outside any open `BEGIN`:** it is connection-local (a reconnect resets the baseline to 0 → false-suppress) and frozen for a read txn's duration (works in autocommit because each PRAGMA implicitly opens+closes a read txn). Only `v1 !== v0` is meaningful. [sqlite.org/pragma.html, isolation.html]
- **Single-flight over `setInterval`-vs-overlap:** a 25–50ms tick fires faster than a `.planctl` re-scan completes; gate with `cycleRunning`/`wakePending` so a mid-scan bump coalesces into one trailing re-run. [autopilot archetype]
- **FSEvents is a best-effort coalescing hint, not a guarantee:** the level-triggered poll is the correctness backstop; never delete the watcher, never make correctness depend on catching every edge. Re-check must be idempotent under the higher call rate. [watchexec macOS FSEvents, LWN edge-triggered]
- **Don't poll faster than ~25ms:** risks interfering with `@parcel/watcher`'s kqueue subscription on macOS.

## Snippet context

No reusable snippets exist for this work: `promptctl find-snippets` returned empty for "data_version poll worker", "worker contract producer", and "heartbeat backstop reconcile". The in-repo worker files (`src/wake-worker.ts`, `src/git-worker.ts`, `src/autopilot-worker.ts`) ARE the canonical reference and are cited as per-task Investigation targets.
