## Description

**Size:** M
**Files:** `src/protocol.ts`, `src/server-worker.ts`, `test/server-worker.test.ts`, `README.md`

### Approach

Two-step rewrite, landing as one commit but staged for readability:

**Step 1 — Protocol shape (`src/protocol.ts`):**
- Add `id?: string` to `PatchFrame` (lines 168-173) and `MetaFrame` (lines 188-193).
- Update JSDoc on both interfaces: replace "Mirrors `patch` in carrying no `id`" with "echoes the originating query's `id`, routing the frame to the correct subscription on a multi-sub connection. Absent when the originating query had no `id` (legacy single-sub client)."
- Update top-of-file block comment (~lines 14-47): remove any "no id" language on patch/meta; note that patch/meta echo subscription ids when present.
- `UnsubscribeFrame.id?: string` already exists (line 140) — JSDoc already says "stop emitting patches for `id` (or all, if omitted)". Confirm the existing wording matches the new server behavior; minor wording pass if helpful.

**Step 2 — Server multi-sub (`src/server-worker.ts`):**

Introduce `SubState` type (place near `ConnState` definition):

```ts
export interface SubState {
  collection: string;
  watched: Set<string>;
  lastSent: Map<string, number>;
  where: ResolvedFilter;
  lastTotal: number;
  lastToken: string;
}
```

Refactor `ConnState` (lines 186-238) — REWRITE the 24-line docstring, then update the interface:

```ts
export interface ConnState {
  subs: Map<string | null, SubState>;  // null = anonymous-sub sentinel (legacy single-sub client)
  pending: { buf: Uint8Array; offset: number } | null;
  buffer: string;
  id: number;  // debug per-conn sequence id
}
```

`newConnState()` returns `{ subs: new Map(), pending: null, buffer: "", id: ++debugCounter }`.

Update `dispatchLine` query handler (lines 718-767):
- On query, compute `subId = frame.id ?? null`.
- Build SubState from `runQuery` result + resolved filter.
- `conn.subs.set(subId, subState)` (atomic replace if subId already exists; matches today's "re-query replaces" semantic per-sub).
- Return `result` frame unchanged (already echoes `frame.id`).

Update `dispatchLine` unsubscribe handler (lines 768-776):
- If `frame.id !== undefined`: `conn.subs.delete(frame.id)` — silent no-op if not found (idempotent).
- If `frame.id === undefined`: `conn.subs.clear()` (clear-all, preserves today's semantic, matches documented protocol).

Update close handler (lines 1431-1443):
```ts
close(socket) {
  socket.data.subs.clear();
  socket.data.pending = null;
}
```

Update `diffTick` (lines 1066-1302) — iterate `(sock, subId, sub)` triples instead of `(sock)`:

```ts
// Build flat list of (sock, subId, sub) triples across all conns
const triples: { sock: Writable; subId: string | null; sub: SubState }[] = [];
for (const sock of conns) {
  for (const [subId, sub] of sock.data.subs) {
    triples.push({ sock, subId, sub });
  }
}

// Group by collection
const byCollection = new Map<string, typeof triples>();
for (const t of triples) {
  if (!byCollection.has(t.sub.collection)) byCollection.set(t.sub.collection, []);
  byCollection.get(t.sub.collection)!.push(t);
}

// Per-collection: probe + conditional changed-rows fetch (from fn-631)
for (const [collection, group] of byCollection) {
  const descriptor = getDescriptor(collection)!;
  const ids = unionWatched(group.map(t => t.sub));  // SubState[], not Writable[]
  const versions = selectVersionsByIds(db, descriptor, ids);
  const changedIds = new Set<string>();
  for (const t of group) {
    for (const id of t.sub.watched) {
      const v = versions.get(id);
      const last = t.sub.lastSent.get(id) ?? -1;
      if (v !== undefined && v !== null && v > last) {
        changedIds.add(id);
      }
    }
  }

  if (changedIds.size > 0) {
    const rows = selectByIds(db, descriptor, [...changedIds]);
    const byId = new Map<string, Row>();
    for (const row of rows) byId.set(String(row[descriptor.pk]), row);

    // Per-sub fanout — backpressure skip is SOCKET-LEVEL
    for (const t of group) {
      if (t.sock.data.pending) continue;
      const patches: PatchFrame[] = [];
      for (const id of t.sub.watched) {
        const row = byId.get(id);
        if (!row) continue;
        const version = row[descriptor.version] as number | null;
        const last = t.sub.lastSent.get(id) ?? -1;
        if (version !== null && version > last) {
          patches.push({
            type: "patch",
            collection,
            rev,
            row,
            ...(t.subId !== null ? { id: t.subId } : {}),
          });
          t.sub.lastSent.set(id, version);
        }
      }
      if (patches.length > 0) writeFrames(t.sock, patches);
    }
  }
}

// Meta-pass byFilter (signature stays (collection, clause, params); fan per-sub at emit)
// ... existing meta logic, iterating triples instead of conns
```

Update `unionWatched` signature (lines 1016-1024): change from `Iterable<Writable>` to `Iterable<SubState>` since the (collection, sub) binding is already made by the grouping above. The function body reads `s.watched` instead of `sock.data.watched`.

### Investigation targets

**Required** (read before coding):
- `src/protocol.ts:118-141` — QueryFrame, UnsubscribeFrame already carry `id?: string`
- `src/protocol.ts:154-161, 246-253` — ResultFrame, ErrorFrame already echo `id`
- `src/protocol.ts:168-193` — PatchFrame, MetaFrame interfaces to extend; line 186 has the "Mirrors patch in carrying no id" sentence to flip
- `src/protocol.ts:287` — `encodeFrame` is sole encoder (no parallel path)
- `src/server-worker.ts:186-213` — 24-line ConnState docstring to REWRITE
- `src/server-worker.ts:214-238` — ConnState interface + `newConnState()`
- `src/server-worker.ts:341-344` — `ResolvedFilter` (SubState.where uses this)
- `src/server-worker.ts:476-566` — `runQuery` (unchanged; SubState seeded from its return)
- `src/server-worker.ts:486, 561, 881` — conditional-spread echo pattern to mirror
- `src/server-worker.ts:696-792` — `dispatchLine` query (718-767) + unsubscribe (768-776) handlers
- `src/server-worker.ts:1016-1024` — `unionWatched` (signature changes)
- `src/server-worker.ts:1066-1302` — diffTick body (post-fn-631)
- `src/server-worker.ts:1099` — world-rev read (unchanged)
- `src/server-worker.ts:1106-1204` — per-collection probe+select+patch-fanout (the loop being refactored)
- `src/server-worker.ts:1176, 1249` — `if (sock.data.pending) continue` backpressure skip (stays as-is)
- `src/server-worker.ts:1212-1237` — meta-pass byFilter signature (stays `(collection, clause, params)`; emits per-sub)
- `src/server-worker.ts:1252-1258` — meta emit (needs id carry-through)
- `src/server-worker.ts:1289-1300` — diffTick TRACE stage names (stay the same: `readWorldRev`, `unionWatched`, `probeVersions`, `selectByIds`, `patchFanout`, `metaCount`)
- `src/server-worker.ts:1431-1443` — close handler (simplifies)
- `test/server-worker.test.ts:97` — `dispatchInit()` test helper (returns fresh ConnState — adjust shape)
- `test/server-worker.test.ts:1043-1065` — `fakeSock()` fixture
- `test/server-worker.test.ts:1079-1099` — `watch()` helper; 35+ call sites
- `test/server-worker.test.ts:1822-1854` — TRACE source-level lint regression test (preserves srvTs gating pattern)
- `test/server-worker.test.ts:1926-1989` — fn-631 trace tests (parse the stage shape; verify range assertions still pass after subs × conns work)
- `README.md` ~lines 514-533 (UDS server description), ~lines 522-533 (diffTick prose)

**Optional** (reference as needed):
- CLAUDE.md "Design stance" section (server-first stance; this is the canonical application of it)
- CLAUDE.md "Worker contract" section (server-worker IS a worker; no lifecycle/shutdown/DB-ownership change)

### Risks

- **35+ `watch()` call sites in test/server-worker.test.ts**: solved by `watch(db, sock, seed, filter, collection, subId = null)` — default-null preserves the legacy anonymous-sub shape; existing tests unchanged. The new multi-sub tests pass explicit subId values.
- **ConnState docstring is 24 lines and very specific**: REWRITE the whole block, don't try to patch. The new docstring describes the multi-sub shape: `subs: Map<string | null, SubState>` where each sub carries its own collection/watched/lastSent/where/lastTotal/lastToken; null is the anonymous-sub sentinel for legacy clients; backpressure (`pending`) stays at socket level so all subs share fate; close handler clears the whole map.
- **byFilter meta-pass signature stays `(collection, clause, params)`**: two subs sharing the same filter on the same socket will end up in the same group with the same total/token — the fanout loop emits one meta per matching sub. The total/token computation happens once per group (today's pattern).
- **`unionWatched` signature change**: from `Iterable<Writable>` to `Iterable<SubState>`. Single caller (the diffTick body), so the signature update is local. Document the change in a one-line comment.
- **Patch/meta wire shape is strictly additive**: old clients ignore unknown `id`; old servers don't emit it. Bun's `JSON.stringify` drops `id: undefined` values, so the conditional-spread is belt-and-braces. Forward and backward compat preserved.
- **`encodeFrame` doesn't need an update**: it's sole-encoder for all frame types; adding an optional field to a frame interface is transparent to the encoder.
- **TRACE stage names stay the same**: per the spec; the locked regex at test/server-worker.test.ts (around 1289-1300 in src) doesn't need updating.
- **fn-631 trace parsers at test/server-worker.test.ts:1926-1989**: check range assertions, not exact ms. Should pass unchanged since diffTick's overall shape is the same; only the iteration unit changes.

### Test notes

**Update `watch()` helper signature** at `test/server-worker.test.ts:1079-1099`:
```ts
export function watch(
  db: Database,
  sock: Writable,
  seed: ReadonlyArray<Row>,
  filter?: Record<string, unknown>,
  collection: string = "jobs",
  subId: string | null = null,  // NEW: default null = anonymous (legacy) sub
): void {
  // ...
  // Instead of seeding top-level slots, set:
  sock.data.subs.set(subId, {
    collection, watched: new Set(...), lastSent: new Map(...),
    where, lastTotal, lastToken,
  });
}
```

All 35+ existing call sites work unchanged.

**New server tests** at the end of the diffTick test block:
1. **Two subs same socket, different collections** — `watch(db, sockA, jobsSeed, undefined, "jobs", "A")` + `watch(db, sockA, epicsSeed, undefined, "epics", "B")`. Advance both collections via setWorldRev + reducer fold. Run diffTick. Assert each emit has `id: "A"` or `id: "B"` correctly; no patches with the wrong subId.
2. **Two subs same socket, same collection, different filters** — both watch `epics` with different `where` clauses. Assert `unionWatched` correctly unions across subs; each sub receives patches for only its watched ids; each meta frame echoes its sub's id.
3. **`unsubscribe{id}` clears only the named sub** — three subs on one conn; unsubscribe one by id; verify the other two continue receiving patches.
4. **`unsubscribe{}` clears all** — same setup; unsubscribe with no id; verify no further patches to that conn (until a new query).
5. **`unsubscribe{id: nonexistent}` is silent no-op** — verify no error frame, no exception, conn state unchanged.
6. **Socket-level backpressure skips ALL subs** — set `sock.data.pending` between ticks; advance multiple collections; verify NO sub's `lastSent`/`lastTotal` advances; clear `pending`; verify all advance on next tick.

**New server integration test** — the convergence-replacement for the 500ms refetch removal:
- Setup: one socket, three subs (epics, jobs, subagent_invocations) — mirrors `subscribeReadiness`'s shape.
- Mutate a row in `epics` (advance its version via reducer fold).
- Run one `diffTick`.
- Assert: the socket received exactly one `patch{id: "<epics-subId>", collection: "epics", ...}` frame.
- Assert: the socket received NO patches for jobs or subagent_invocations (only the mutated row's collection got a patch).
- This is the on-disk evidence that multi-sub fanout works end-to-end; Task B's 500ms refetch removal rides on this guarantee.

## Acceptance

- [ ] `src/protocol.ts` PatchFrame and MetaFrame gain `id?: string` with updated JSDoc; top-of-file block comment updated.
- [ ] `SubState` type introduced in `src/server-worker.ts`; ConnState refactored to `subs: Map<string | null, SubState>`.
- [ ] 24-line ConnState docstring at lines 186-213 REWRITTEN entirely.
- [ ] `dispatchLine` query handler keys sub by `frame.id ?? null` (atomic replace per subId).
- [ ] `dispatchLine` unsubscribe handler: with id → silent delete; without id → clear-all.
- [ ] `diffTick` iterates `(sock, subId, sub)` triples; groups by `sub.collection`; per-collection probe + conditional changed-rows fetch + per-sub patch fanout. Backpressure skip `if (sock.data.pending) continue` stays.
- [ ] Patch and meta frames emit `id` when `subId !== null` (conditional-spread pattern); always emit `collection`.
- [ ] `unionWatched` signature changes to `Iterable<SubState>`; single caller updated.
- [ ] Meta-pass byFilter signature stays `(collection, clause, params)`; fans one meta per matching sub at emit time.
- [ ] Close handler simplifies to `socket.data.subs.clear(); socket.data.pending = null;`.
- [ ] `test/server-worker.test.ts` `watch()` helper gains `subId = null` default param; all 35+ existing call sites work unchanged.
- [ ] Six new server tests cover: two-subs-different-collections, two-subs-same-collection-different-filters, unsubscribe-by-id, unsubscribe-clear-all, unsubscribe-nonexistent-silent, socket-backpressure-all-subs.
- [ ] New server integration test: mutate row → all subscribed `(conn, sub)` pairs receive patch within one diffTick.
- [ ] fn-631 TRACE stage names + range assertions still pass.
- [ ] README.md §architecture/§diffTick (~522-533) revised in place to reflect multi-sub iteration; §UDS server (~514-533) revised to drop "the active subscription" language.
- [ ] `bun test` green.

## Done summary
Refactored ConnState to subs: Map<string|null,SubState>. Added SubState type, rewrote ConnState docstring, updated dispatchLine query/unsubscribe handlers, refactored diffTick to iterate (sock,subId,sub) triples grouped by collection. PatchFrame/MetaFrame gain id?: string. watch() helper gains subId=null param. Six new multi-sub tests + integration test. All 85 server-worker tests pass.
## Evidence
