## Description

**Size:** M
**Files:** test/collections.test.ts, test/events-ingest-worker.test.ts, test/reclaim.test.ts, test/autopilot-worker.test.ts

### Approach

Four root-suite tests get killed by the 10s per-test ceiling under contention; fix each by the cheapest coverage-neutral lever, keeping the global `--timeout=10000` untouched (it is the suite's only hang detector — CLAUDE.md: no watchdog). (1) collections.test.ts:1143 — the seed loop inserts MAX_IN_PARAMS+5 (~1004) rows via per-row autocommit `seedJob` (:110); wrap the seed in a single `db.transaction()` to collapse ~1004 fsyncs to 1. The test's second `openDb(dbPath)` connection (file-backed by necessity, :48-54) is untouched. (2) events-ingest-worker.test.ts:819 — the cost is PRODUCTION `scanEventsLogDir` inserting 300 rows (not test seed), so reducing it would change what the exactly-once contract proves; give the test a scoped 3rd-arg timeout (e.g. 30000) with a one-line rationale comment. (3) reclaim.test.ts:202 — real DB swap + WAL/SHM ops; scoped 3rd-arg timeout, and make the WAL/SHM sidecar cleanup awaited (not fire-and-forget) so a slow checkpoint on a loaded box can't leak sidecars into the next test. (4) autopilot-worker.test.ts:7919 — pure fakeRun git seam with no I/O loop (12.4s observed is event-loop starvation); scoped 3rd-arg timeout only. Bun's per-test 3rd-arg budget is verified to override the CLI `--timeout` upward and is currently unused in the repo — these are its first uses, so keep the pattern exemplary (rationale comment on every bump).

### Investigation targets

**Required** (read before coding):
- test/collections.test.ts:110 — seedJob's per-row autocommit shape; :1143 the named test; :48-54 why the DB is file-backed
- test/events-ingest-worker.test.ts:819 — the exactly-once drain test and its 25-file × 12-record fixture
- test/reclaim.test.ts:202 — the OLD-sidecar swap test and its cleanup path

**Optional** (reference as needed):
- test/autopilot-worker.test.ts:7919 — the starvation-only test
- scripts/test-full.ts — per-suite 300s budget; confirm worst-case root-suite wall with the new scoped budgets stays inside it
- CLAUDE.md:99-109 — Test isolation rules (poll don't sleep; never hang or spin)

### Risks

Scoped 30s budgets on 3-4 tests must not push the root suite past test-full's 300s per-suite wall under worst-case contention (parallel=5 makes this comfortable, but state the math in the Done summary).

### Test notes

`bun run test` green; each bumped test carries `test(name, fn, NNNNN)` + rationale; the collections seed change is behavior-identical (same rows, one transaction).

## Acceptance

- [ ] collections seed runs in a single transaction; test asserts the same MAX_IN_PARAMS+5 contract
- [ ] events-ingest, reclaim, and finalizeEpic tests carry scoped 3rd-arg timeouts with rationale comments; root `--timeout=10000` unchanged
- [ ] reclaim's WAL/SHM cleanup is awaited/serialized so no sidecar leaks under load

## Done summary

## Evidence
