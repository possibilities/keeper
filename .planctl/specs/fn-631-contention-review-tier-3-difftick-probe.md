## Overview

Tier 3 epic 1 of the keeper contention review fix plan. Rewrite the realtime `diffTick` at `src/server-worker.ts:1057-1242` from "decode every watched row each tick" to "version-probe first, decode only changed rows." The current algorithm reads full rows + JSON-decodes all 4 embedded array columns (`tasks`, `depends_on_epics`, `jobs`, `job_links`) for every watched row on every tick — ~682 epics × 4 JSON columns × every tick ≈ ~2 MB of `JSON.parse` per tick in steady state, which the reviewer's Q4 hypothesis (event-loop saturation, decode-dominated) identifies as the dominant cause of the observed 2–3 s `diffTick` stalls.

Reviewer's prescription (response Q4): (1) first pass reads only `{pk, version}` via a new `selectVersionsByIds` helper; (2) per-conn-per-id comparison against `lastSent` builds a `changedIds` set across ALL conns (matching today's union behavior — no pending skip in this loop); (3) only if `changedIds` is non-empty, second pass fetches full rows via the existing unchanged `selectByIds` and emits patches. The meta second-pass (`countAndToken`) is independent and runs unchanged. Backpressure invariant preserved (skipped conn doesn't advance lastSent — the skip lives in the fanout loop only).

Wire protocol unchanged. Clients receive the same `patch` frames with the same row payload — pure server-internal optimization.

## Quick commands

- `bun test test/server-worker.test.ts` — full diffTick suite green
- `bun test test/collections.test.ts` — selectVersionsByIds unit test green
- `bun test` — full project green (no regressions)
- `KEEPER_TRACE_SERVER=1 launchctl kickstart -k gui/$UID/arthack.keeperd` — restart with tracing
- `tail -f ~/.local/state/keeper/server.stderr | grep '\[srv-ts\].*diffTick'` — observe new `probeVersions=<ms>` stage + the dramatic drop in `selectByIds=<ms>`

## Acceptance

- [ ] `selectVersionsByIds(db, descriptor, ids: readonly string[]): Map<string, number | null>` added to `src/collections.ts`, mirrors `selectByIds`'s prelude (empty → empty Map; MAX_IN_PARAMS cap → throw), NEVER calls `decodeRow`
- [ ] `selectByIds` in `src/collections.ts` UNCHANGED (decode still bundled inside; semantics + API preserved)
- [ ] `diffTick` rewritten to two-pass shape: probe → compute `changedIds` across ALL conns (no pending skip in that loop) → if non-empty, fetch full rows via existing `selectByIds([...changedIds])` → per-conn fanout with `pending` skip preserved
- [ ] Meta second-pass (`countAndToken`) UNCHANGED — runs independently of the patch path
- [ ] New `probeVersions=<ms>` stage inserted between `unionWatched=<ms>` and `selectByIds=<ms>` in the `formatStages` emission
- [ ] Locked TRACE regex at `test/server-worker.test.ts:1818` updated to include `probeVersions=<ms>` in the expected stage list — child-spawn harness's mocked `performance.now()` (+20 ms per call) still deterministically trips the 10 ms gate after the new stage
- [ ] Backpressure invariant preserved — `test/server-worker.test.ts:1220` continues to pass unchanged (`lastSent` NOT advanced on `pending` skip)
- [ ] All existing diffTick tests at `test/server-worker.test.ts:1131-1700` pass unchanged (no test-shape rewrites except the locked regex update)
- [ ] New unit test for `selectVersionsByIds` in `test/collections.test.ts`: empty ids → empty Map; known seed → correct `(pk, version)` pairs; cap throw on overflow; Map value type `number | null`
- [ ] New property test in `test/server-worker.test.ts`: seed N watched rows, advance K via `setWorldRev`, assert (a) exactly K patches emitted, (b) patched rows have correctly decoded JSON columns, (c) the N-K unchanged rows are NOT decoded (verified via a `decodeRow` call counter or equivalent spy)
- [ ] README.md Architecture section (~lines 514-530) one-sentence diffTick description revised to describe the two-pass shape (preserves the existing "pushes `patch` frames to subscribed clients" conclusion)
- [ ] Comment in `diffTick` body explicitly notes the read-snapshot drift between probe and changed-rows-fetch is the same race class as today's `readWorldRev` + `selectByIds` (no new race)
- [ ] EVIDENCE: with `KEEPER_TRACE_SERVER=1`, capture before/after `diffTick` p50/p95/p99 timings under a representative live load (board + autopilot + git + usage clients all connected). Include actual numbers in `## Evidence` — expected outcome: `selectByIds` p95 drops by >10× when steady-state changes are sparse
- [ ] Wire protocol unchanged: same patch frame shape, same row payload, same meta frames
- [ ] `bun test` green

## Early proof point

Task that proves the approach: `<epic>.1` (the only task — single-task epic). Once it lands, restart the daemon with `KEEPER_TRACE_SERVER=1` and observe `[srv-ts] diffTick` log lines under live board+autopilot+git+usage client load. Today the `selectByIds` stage in those lines dominates (often >100 ms per tick under epics-heavy load); after the rewrite, `probeVersions` should be cheap (<5 ms) and `selectByIds` should be cheap too (only fetching ~0-5 changed rows). If the rewrite ships but the metrics don't move: investigate (a) whether `KEEPER_TRACE_SERVER` is actually set in the running daemon's env, (b) whether the tick gate (`any-stage > 5ms || total > 10ms`) is suppressing the log entirely (which would itself be evidence of the fix), (c) whether `unionWatched` is somehow returning the full table every tick (suggesting a different bug class — possibly a runaway subscription).

## References

- `/Users/mike/docs/2026-05-27-keeper-syncing-api-daemon-contention-review.md` — original Carmack-style audit (F1-F10 across event-loop, decode, and reducer)
- `/Users/mike/docs/2026-05-27-keeper-review-followup-response.md` — reviewer's revised priority plan; Q4 carries the explicit version-probe-first prescription
- `fn-622-contention-review-tier-1-fix-pack` — Tier 1: gate srvTs, staged timing, slow-flight reconnect, OpenDbOptions.migrate (closed + approved)
- `fn-628-contention-review-tier-2-index-pack` — Tier 2: idx_epics_sort_path + idx_jobs_created_state + planctl partial indexes + UNION rewrite + ANALYZE (closed + approved)
- sqlite-zod-orm `bench/poll-strategy.ts` — benchmarks the probe-first pattern in bun:sqlite

## Docs gaps

- **README.md** lines ~514-530 (Architecture section): replace the single-sentence diffTick description "On each `data_version` tick the server re-reads its watched rows, diffs the per-row version column, and pushes `patch` frames to subscribed clients." with a two-clause version naming the version-probe-first pass and the selective decode second pass. Match the existing one-sentence-mechanism inline prose style — no bullet lists, no code blocks.

## Best practices

- **Build `changedIds` across ALL conns, not just non-pending ones.** A pending-conn skip in the `changedIds` construction would deprive a sole backpressured watcher of a needed fetch — still eventually consistent (the next tick re-probes since `lastSent` didn't advance) but adds a tick of drain latency. Matching today's behavior (selectByIds fetches the full union regardless of pending) keeps the algorithm-shape change minimal and the latency profile identical.
- **Keep the pending-skip in the fanout loop ONLY.** That's where `lastSent` advances; the skip there preserves the no-advance-on-skip invariant. The existing test at `test/server-worker.test.ts:1220` is the regression guard.
- **No `BEGIN` on the poll connection.** The two-query pattern runs in autocommit. `data_version` would freeze under a `BEGIN`, blinding the poll loop. The two queries CAN race a writer commit between them — same race class as today's `readWorldRev` + `selectByIds` sequence (handled by self-correcting next tick).
- **Use `db.prepare()` per-call, not `db.query()`.** The IN-list arity varies per tick; caching by SQL string would leak prepared-statement entries. Mirrors the existing `selectByIds` pattern at `src/collections.ts:455-457`.
- **Schema never deletes rows.** `versions.get(id) === undefined` shouldn't happen in practice; treat it as a skip (same shape as today's `!row` guard at `src/server-worker.ts:1130`).
- **Preserve `Map<string, number | null>` shape.** Today's cast at `src/server-worker.ts:1133` is `number | null`. Returning that exact shape from `selectVersionsByIds` keeps the existing `version !== null && version > last` guard unchanged and future-proofs against schema changes that might make version nullable.
- **Stage names: add `probeVersions`, keep `selectByIds`.** Don't rename the existing `selectByIds` label even though its scope narrows — the renamed version would force broader test churn for negligible clarity gain. The dramatic post-rewrite drop in `selectByIds` p95 IS the diagnostic signal.
