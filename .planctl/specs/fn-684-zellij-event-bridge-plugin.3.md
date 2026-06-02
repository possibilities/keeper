## Description

**Size:** M
**Files:** src/zellij-events-worker.ts (new), src/zellij-events.ts (new), src/daemon.ts, src/db.ts, test/zellij-events-worker.test.ts

### Approach

Add the eighth `@parcel/watcher` producer worker (twelfth thread), mirroring `src/dead-letter-worker.ts`: subscribe on the events DIR (not a file — there is one NDJSON per session), post a contentless "go look" message, use `RescanScheduler` from `src/rescan.ts`, tolerate a missing dir (skip + stay alive), hold NO DB handle, `unsubscribe()` in the shutdown handler. Add `resolveZellijEventsDir()` to `src/db.ts` mirroring `resolveDeadLetterDir` (env `KEEPER_ZELLIJ_EVENTS_DIR` wins, `~/.local/state/keeper/zellij-events` default — matching the transport path chosen in task 1). Add `src/zellij-events.ts` with `parseZellijEventLine` (null on partial/malformed, NEVER throws — mirror `src/dead-letter.ts`) and a forward-tail watermark keyed by `(session, epoch)` so a plugin reload (new epoch) resets cleanly and a daemon restart re-tails from the last offset, not byte 0. In `daemon.ts` main, on each worker message scan the new lines and for each `(session, pane_id)` resolve the job via the EXISTING `readLiveJobsWithCoords` join (`src/backend-worker.ts:111-123`), then mint the EXISTING `BackendExecSnapshot` (`{kind:"backend-exec-snapshot", job_id, tab_id, tab_name}`) through `stmts.insertEvent` verbatim (`daemon.ts:1891-1961`). Never emit a clobbering snapshot (empty `tab_name` — the fold's `tab_name = ?` is non-COALESCE). Gate the worker spawn behind `KEEPER_ZELLIJ_FEED` (default = poller; this worker dormant unless `=plugin`). Update the daemon header ELEVEN->TWELVE, add the spawn/shutdown/exited/terminate lines, and join the new env var to the test base-env list.

### Investigation targets

**Required** (read before coding):
- /Users/mike/code/keeper/src/dead-letter-worker.ts — watcher-half template (subscribe, RescanScheduler, missing-dir tolerance, no DB handle, shutdown unsubscribe)
- /Users/mike/code/keeper/src/dead-letter.ts — null-on-partial parse + one-write-per-line serialize precedent
- /Users/mike/code/keeper/src/daemon.ts:1891 — BackendExecSnapshot mint (reuse verbatim); :2461 teardown ("eleven" -> "twelve")
- /Users/mike/code/keeper/src/backend-worker.ts:111 — readLiveJobsWithCoords (the (session,pane)->job join to preserve)
- /Users/mike/code/keeper/src/reducer.ts:3499 — extract/foldBackendExecSnapshot (note tab_name is non-COALESCE; never clobber)
- /Users/mike/code/keeper/src/db.ts:356 — resolveDeadLetterDir pattern to clone

**Optional** (reference as needed):
- /Users/mike/code/keeper/src/rescan.ts — RescanScheduler / isDropError

### Risks

- Forward-tail watermark must reset on `epoch` change (plugin reload) or new lines after a reload get dropped as already-seen.
- Cross-session pane-id collision — the join MUST stay `(session, pane_id)`; pane ids are unique only within a session.
- Boot scan must re-tail from the persisted watermark, not byte 0, or every restart re-parses the whole growing file.

### Test notes

Export a pure scan+join fn and test it against a tmp DB + tmp NDJSON tree (mirror `test/dead-letter-worker.test.ts`): idempotent re-apply, partial-line tolerance, epoch reset, cross-session isolation, never-throw, no-clobber on empty tab_name. Add `KEEPER_ZELLIJ_EVENTS_DIR` to the test sandbox base-env (never spread process.env for state paths).

## Acceptance

- [ ] New worker watches the events dir and posts contentless "go look" messages; holds no DB handle; unsubscribes on shutdown
- [ ] Main scans new lines, joins `(session, pane_id) -> job_id`, and mints the existing `BackendExecSnapshot` shape verbatim — no reducer/schema change
- [ ] Watermark resets on epoch change and survives daemon restart (re-tail from offset, not byte 0)
- [ ] Never mints a clobbering empty-`tab_name` snapshot
- [ ] Spawn gated behind `KEEPER_ZELLIJ_FEED`; daemon header/teardown updated to TWELVE; pure scan+join fn has tests

## Done summary

## Evidence
