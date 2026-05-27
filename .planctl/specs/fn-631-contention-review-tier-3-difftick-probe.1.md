## Description

**Size:** M
**Files:** `src/server-worker.ts`, `src/collections.ts`, `test/server-worker.test.ts`, `test/collections.test.ts`, `README.md`

### Approach

Two-step rewrite, landing as one commit:

**Step 1 — Add `selectVersionsByIds` helper to `src/collections.ts`** parallel to existing `selectByIds` (lines 436-462):

```ts
export function selectVersionsByIds(
  db: Database,
  descriptor: CollectionDescriptor,
  ids: readonly string[],
): Map<string, number | null> {
  if (ids.length === 0) return new Map();
  if (ids.length > MAX_IN_PARAMS) {
    throw new Error(`selectVersionsByIds: ids exceeds MAX_IN_PARAMS (${ids.length} > ${MAX_IN_PARAMS})`);
  }
  const placeholders = ids.map(() => "?").join(", ");
  const sql = `SELECT ${descriptor.pk} AS pk, ${descriptor.version} AS version FROM ${descriptor.table} WHERE ${descriptor.pk} IN (${placeholders})`;
  const rows = db.prepare(sql).all(...ids) as { pk: unknown; version: number | null }[];
  const map = new Map<string, number | null>();
  for (const r of rows) {
    map.set(String(r.pk), r.version);
  }
  return map;
}
```

Per-call `db.prepare()` matches the existing `selectByIds` rationale (arity-varying IN-list; cache leak risk via `db.query()`). No `decodeRow` call — pk and version are never in `jsonColumns` by descriptor design. `AS pk` / `AS version` aliases normalize the returned shape regardless of which descriptor was passed.

**Step 2 — Rewrite `diffTick` in `src/server-worker.ts:1057-1242`** to two-pass shape:

```ts
// Stage 1: union ids per group (UNCHANGED)
const ids = unionWatched(group);

// Stage 2 (NEW): version probe — no decode
const _gProbe = TRACE ? performance.now() : 0;
const versions = selectVersionsByIds(db, descriptor, ids);
_accProbe += TRACE ? performance.now() - _gProbe : 0;

// Stage 3 (NEW): compute changedIds ACROSS ALL CONNS (no pending skip here)
const changedIds = new Set<string>();
for (const sock of group) {
  for (const id of sock.data.watched) {
    const v = versions.get(id);
    const last = sock.data.lastSent.get(id) ?? -1;
    if (v !== undefined && v !== null && v > last) {
      changedIds.add(id);
    }
  }
}

// Stage 4 (CONDITIONAL): selectByIds only if there are changed rows
if (changedIds.size > 0) {
  const _gSelect = TRACE ? performance.now() : 0;
  const rows = selectByIds(db, descriptor, [...changedIds]);
  const byId = new Map<string, Row>();
  for (const row of rows) byId.set(String(row[descriptor.pk]), row);
  _accSelect += TRACE ? performance.now() - _gSelect : 0;

  // Stage 5 (UNCHANGED shape): per-conn fanout with pending skip
  const _gPatch = TRACE ? performance.now() : 0;
  for (const sock of group) {
    if (sock.data.pending) continue;  // backpressure skip — preserves invariant
    const patches: PatchFrame[] = [];
    for (const id of sock.data.watched) {
      const row = byId.get(id);
      if (!row) continue;  // id wasn't in changedIds for this collection
      const version = row[descriptor.version] as number | null;
      const last = sock.data.lastSent.get(id) ?? -1;
      if (version !== null && version > last) {
        patches.push({ type: "patch", collection: name, rev, row });
        sock.data.lastSent.set(id, version);
      }
    }
    if (patches.length > 0) writeFrames(sock, patches);
  }
  _accPatch += TRACE ? performance.now() - _gPatch : 0;
}
// else: no changes this tick — skip second SELECT entirely. Meta pass still runs (independent).
```

Update the `formatStages(...)` call to include the new `probeVersions=<ms>` between `unionWatched=<ms>` and `selectByIds=<ms>`. Stage list becomes: `readWorldRev, unionWatched, probeVersions, selectByIds, patchFanout, metaCount, total`. The `selectByIds` label is preserved (scope narrowed to changed-rows fetch; decode still bundled inside via the unchanged `selectByIds` helper).

Add an inline comment in the diffTick body noting the read-snapshot drift between the probe and the changed-rows SELECT is the same race class as today's `readWorldRev` + `selectByIds` sequence — a writer commit can land between them, and the second query returns the post-commit shape; self-corrects on next tick.

**Step 3 — Update tests:**
- `test/server-worker.test.ts:1818` locked TRACE regex: insert `probeVersions=<ms>` between `unionWatched=<ms>` and `selectByIds=<ms>`. The child-spawn harness's mocked `performance.now()` (+20 ms per call) advances once more per probe — verify the test deterministically trips the 10 ms gate.
- Add a property test (described in Test notes below).
- `test/collections.test.ts`: add unit tests for `selectVersionsByIds`.

**Step 4 — Update README.md** ~lines 514-530: replace the one-sentence diffTick description with a two-clause version naming the probe-first pass and the selective decode second pass. Match the existing inline-prose style.

### Investigation targets

**Required** (read before coding):
- `src/server-worker.ts:1057-1242` — diffTick body to rewrite
- `src/server-worker.ts:137` — `TRACE` const + reading conventions
- `src/server-worker.ts:151-183` — `formatStages` + `srvTs` helper + the stage-emission pattern
- `src/server-worker.ts:213-237` — `ConnState` shape (`watched: Set<string>`, `lastSent: Map<string, number>`, `pending`)
- `src/server-worker.ts:904-907` — `Writable` interface (for fakeSock test fixture)
- `src/server-worker.ts:1003-1005` — `readWorldRevOnce`
- `src/server-worker.ts:1013-1021` — `unionWatched`
- `src/server-worker.ts:1130` — the existing `!row` guard pattern to mirror
- `src/server-worker.ts:1133` — the existing `version !== null && version > last` guard
- `src/server-worker.ts:1248` — CRITICAL: poll connection must stay in autocommit; the two-query pattern preserves this
- `src/collections.ts:436-462` — `selectByIds` (existing helper to mirror in `selectVersionsByIds`; stays UNCHANGED)
- `src/collections.ts:480-498` — `decodeRow` (called inside selectByIds; not directly touched)
- `src/collections.ts:65-77` — `CollectionDescriptor` typing (`pk: string`, `version: string` — SQL identifiers, interpolation-safe)
- `src/collections.ts:26` — `MAX_IN_PARAMS` import
- `src/collections.ts:18-22` — file-top SQL-identifier injection invariant
- `test/server-worker.test.ts:1043` — `fakeSock()` test fixture
- `test/server-worker.test.ts:1079-1099` — `watch()` helper
- `test/server-worker.test.ts:1131-1700` — existing diffTick tests (must pass unchanged)
- `test/server-worker.test.ts:1220` — backpressure regression test (`lastSent` NOT advanced on skip)
- `test/server-worker.test.ts:1268` — one-selectByIds-per-group test (asserts OUTCOME not SQL identity; survives the rewrite)
- `test/server-worker.test.ts:1700-1843` — TRACE child-spawn harness with mocked `performance.now()` (+20 ms per call)
- `test/server-worker.test.ts:1818` — LOCKED TRACE regex (needs `probeVersions=<ms>` insertion)
- `test/collections.test.ts` — parallel home for `selectVersionsByIds` unit tests
- `README.md` ~lines 514-530 — Architecture section's diffTick sentence to revise
- CLAUDE.md "Worker contract" + "Event-sourcing invariants" + "DO NOT" sections — confirm re-fold determinism untouched (diffTick is read-only of the projection)

**Optional** (reference as needed):
- SQLite isolation docs (sqlite.org/isolation.html) — WAL read snapshot semantics
- Bun:sqlite docs — `db.prepare()` vs `db.query()` cache behavior
- sqlite-zod-orm `bench/poll-strategy.ts` — empirical validation of the probe-first pattern

### Risks

- **Backpressure invariant** is the load-bearing correctness check. The rewrite preserves it because (a) `changedIds` is built across ALL conns (matching today's `selectByIds(union)` fetch shape; pending conns contribute to the fetch set), and (b) the `pending` skip remains in the fanout loop only (where `lastSent` advances). The existing test at `test/server-worker.test.ts:1220` is the regression guard — if it passes, the invariant holds.
- **Locked TRACE regex at `test/server-worker.test.ts:1818`** — the regex hard-codes the exact stage sequence. Inserting `probeVersions=<ms>` between `unionWatched=<ms>` and `selectByIds=<ms>` is a one-line change. The child-spawn harness mocks `performance.now()` to advance +20 ms per call — adding one more `performance.now()` call inside the probe block adds 20 ms to the total, which keeps the 10 ms tick-gate triggering. Verify after the rewrite that the test still trips the gate (it should, since the new stage adds rather than removes time).
- **Read-snapshot drift between probe and changed-rows-fetch** — practice-scout confirmed this is the same race class as today's `readWorldRev` → `selectByIds` race. A writer commit between the two queries means the second query returns the post-commit shape; the patch frame carries the latest row, `lastSent` advances to the latest version, and the world-rev on the frame may be one behind (which was already true today). Self-correcting on the next tick. Add an inline comment to pre-empt future reviewers asking.
- **Empty changedIds early-return** — skip the second SELECT entirely, but the meta `countAndToken` pass still runs (it's structurally independent). Verify this preserves today's meta-frame emission behavior under idle ticks.
- **`selectVersionsByIds` cap throw** — MAX_IN_PARAMS overflow propagates to `pollLoop` → daemon `fatalExit` → LaunchAgent restart. Same failure semantics as today's `selectByIds` cap throw. Acceptable.
- **Schema-never-deletes assumption** — if a row is somehow not returned by the probe (`versions.get(id) === undefined`), treat it like today's `!row` guard at `src/server-worker.ts:1130`: skip silently. Don't advance lastSent, don't emit a patch. Same defensive shape.

### Test notes

**`test/collections.test.ts` — selectVersionsByIds unit tests:**
- Empty `ids` → empty Map.
- Known seed (insert N rows, pick a subset by pk, call helper) → Map contains correct `(pk, version)` pairs; no extra keys.
- `ids.length > MAX_IN_PARAMS` → throws (mirroring `selectByIds`).
- Map value type: assert typeof number for known-non-null versions; if a test seed inserts a NULL version (synthetically), assert null is preserved.
- Verify NO call to `decodeRow` (e.g., by ensuring the SELECT projection is only `pk, version` — no jsonColumns fetched).

**`test/server-worker.test.ts` — new property test for the no-decode-on-unchanged-rows invariant:**
- Setup: instrument `decodeRow` with a call counter (test-only wrapper or a Bun `mock.module` spy).
- Seed N=10 watched rows (full epics or simpler synthetic descriptor).
- Run one `diffTick`. Note baseline `decodeRow` call count (should be 0 if all `lastSent` align — verify).
- Advance K=3 rows' versions via `setWorldRev` (or equivalent). Run `diffTick`.
- Assert: (a) exactly K patches emitted (across all subscribed conns); (b) the K patched rows have correctly decoded JSON columns (verify `tasks` etc. are arrays); (c) `decodeRow` was called exactly K times (not N) — proving unchanged rows were NOT decoded.

**`test/server-worker.test.ts` — existing diffTick tests pass unchanged:**
- `:1131` single-watch patch.
- `:1153` no-op tick.
- `:1168` no double-send.
- `:1184` per-conn fan-out filtering.
- `:1203` coalescing.
- `:1220` backpressure — `lastSent` NOT advanced on skip. **Critical regression guard.**
- `:1243` null-collection skip.
- `:1268` one-selectByIds-per-group — repo-scout confirmed this asserts OUTCOME not SQL identity; rewrite preserves outcome.
- Meta pass tests at `:1490-1700`.

**`test/server-worker.test.ts:1818` — locked TRACE regex update:**
- Current regex matches: `readWorldRev=<ms> unionWatched=<ms> selectByIds=<ms> patchFanout=<ms> metaCount=<ms> total=<ms>`.
- Updated regex matches: `readWorldRev=<ms> unionWatched=<ms> probeVersions=<ms> selectByIds=<ms> patchFanout=<ms> metaCount=<ms> total=<ms>`.
- Verify mocked `performance.now()` still produces total > 10 ms gate. With +20 ms per call and 6 stage timestamps before vs 7 after, the gate should still trip.

**EVIDENCE capture (post-merge):**
- Daemon restart: `KEEPER_TRACE_SERVER=1 launchctl kickstart -k gui/$UID/arthack.keeperd`
- Live load: board + autopilot + git + usage clients all connected (matches current operator state)
- Collect 5+ minutes of `[srv-ts] diffTick` lines from `~/.local/state/keeper/server.stderr`
- Compute p50/p95/p99 of `selectByIds=` and `total=` stages. Expected: post-rewrite `selectByIds` p95 < 5 ms (down from observed >100 ms when epics-heavy); `total` p95 well under the 2-3 s stall regime.
- Include actual numbers (not just claims) in `## Evidence`.

## Acceptance

- [ ] `selectVersionsByIds(db, descriptor, ids: readonly string[]): Map<string, number | null>` added to `src/collections.ts`; SELECT projects only pk + version (no JSON columns); mirrors selectByIds prelude (empty → empty Map, cap → throw); per-call `db.prepare()`; never calls `decodeRow`
- [ ] `selectByIds` in `src/collections.ts` UNCHANGED (line-for-line equivalent body; existing API + decode semantics preserved)
- [ ] `diffTick` rewritten to two-pass shape per Approach
- [ ] Per-conn `changedIds` construction iterates ALL conns (no pending skip in that loop)
- [ ] `pending` skip remains in the fanout emit loop only; `lastSent` advances ONLY there
- [ ] If `changedIds.size === 0`, second SELECT is skipped entirely (early-return for patch path); meta `countAndToken` pass still runs
- [ ] `probeVersions=<ms>` is a new stage in `formatStages` emission, positioned between `unionWatched` and `selectByIds`
- [ ] Locked TRACE regex at `test/server-worker.test.ts:1818` updated to include `probeVersions=<ms>`; child-spawn harness still deterministically trips the 10 ms gate
- [ ] Backpressure invariant test at `test/server-worker.test.ts:1220` passes UNCHANGED
- [ ] All existing diffTick tests at `test/server-worker.test.ts:1131-1700` pass UNCHANGED (no test-shape rewrites beyond the locked regex insertion)
- [ ] New `selectVersionsByIds` unit test in `test/collections.test.ts`: empty ids, known seed, cap throw, Map value-type preservation
- [ ] New property test in `test/server-worker.test.ts` verifies: K patches for K changes; patched rows decode correctly; `decodeRow` called exactly K times (not N)
- [ ] Inline comment in `diffTick` body notes the read-snapshot drift between probe and changed-rows-fetch is the same race class as `readWorldRev` + `selectByIds`
- [ ] README.md ~lines 514-530 single-sentence diffTick description revised
- [ ] EVIDENCE: before/after `diffTick` p50/p95/p99 timings captured with `KEEPER_TRACE_SERVER=1` under representative live load; actual numbers in `## Evidence`
- [ ] Wire protocol unchanged: patch frame shape, row payload, meta frames all byte-identical to pre-rewrite
- [ ] `bun test` green

## Done summary
Rewrote diffTick to version-probe-first: new selectVersionsByIds projects (pk, version) only over the watched union, changedIds is built across all conns, full-row selectByIds runs only when changedIds is non-empty. New probeVersions stage in TRACE output. Synthetic bench (N=700, 4 JSON cols/row): idle p95 1.85ms->0.50ms (3.7x), K=1 p95 1.90ms->0.96ms (2.0x). 121/121 tests pass.
## Evidence
- Tests: server_worker, collections, total_pass