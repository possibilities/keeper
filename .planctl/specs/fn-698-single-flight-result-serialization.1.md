## Description

**Size:** M
**Files:** src/server-worker.ts, test/server-worker.test.ts, README.md (architecture paragraph), src/protocol.ts (optional ResultFrame JSDoc note)

Add a per-server-instance, per-world-rev result memo so concurrent
identical query refetches share ONE SELECT + ONE serialize, and fan out
per-connection pre-serialized result lines. Eliminates the residual
serialize-on-the-event-loop latency band. Contract-touching (the internal
dispatch→write transport gains a pre-serialized variant) — xhigh.

### Approach

Phase 1 — the memo. Introduce a per-server-instance result cache, owned in
the `startServer` closure (like `conns`/`writerDb`) and threaded into
`handleData` → `dispatchLine` as an optional trailing param (mirrors
`writerDb?`/`asyncCtx?` so existing direct-`dispatchLine` tests skip it).
Shape: a single-worldRev holder `{ worldRev: number, entries: Map<sigKey,
Entry> }`; `Entry = { rows, rowsJson, total, token, where }`. In the
query branch, after `readWorldRev(db)` (:1091): if the read worldRev !==
holder.worldRev, REPLACE `entries` with a fresh Map and set
holder.worldRev (clean reset — no stale-rev entry can survive). Build
`sigKey` from `collection` + `where.clause` + `where.params` + sortCol +
dir + limit + offset — reuse the `seed.where` (`ResolvedFilter`) that
`runQuery` already exfiltrates via the out-param, don't re-derive from
`frame.filter`. On miss (and only if `out.type === "result"`): run
`runQuery`, `JSON.stringify(out.rows)` once, store the Entry (subject to
the distinct-signature cap below). On hit: reuse the Entry — no runQuery,
no countAndToken. WRAP the whole memo block in try/catch so any failure
degrades to today's un-memoized `runQuery` + `encodeFrame` path
(`dispatchLine` must never throw).

Phase 2 — pre-serialized fan-out. Build each connection's result LINE by
concatenation, byte-identical to `encodeFrame` of today's ResultFrame
(insertion key order `type, [id], collection, rev, total, rows`):
`{"type":"result"` + (frame.id !== undefined ? `,"id":` +
JSON.stringify(frame.id) : ``) + `,"collection":` +
JSON.stringify(out.collection) + `,"rev":` + rev + `,"total":` + total +
`,"rows":` + rowsJson + `}\n`. Carry it through dispatch→write as an
internal `PreSerialized { __line: string }` sentinel that `writeFrames`
recognizes and writes verbatim at BOTH encode sites (fresh :1389 AND the
backpressure pending-append :1382), leaving the object path intact for
every other frame type. NOT a wire-protocol addition.

Phase 3 — per-conn SubState seed unchanged. The seed (:1116-1133) STILL
runs per connection, now off the cached `Entry.rows` (`new Set`/`new Map`
copy the array, so sharing is safe) + cached `total`/`token`/`where`.

Phase 4 — cap + trace. Distinct-signature cap (e.g. MAX 256) counted per
worldRev window: when full, a NEW signature runs un-memoized (never evict
the already-cached hot board signature mid-burst; 21 identical = 1 entry,
never capped). Add `KEEPER_TRACE_SERVER` hit/miss/serialize-once stage
lines in the existing `formatStages`/`srvTs` shape.

### Investigation targets

**Required** (read before coding):
- src/server-worker.ts:1073-1135 — dispatchLine query branch (readWorldRev :1091, runQuery :1101, SubState seed :1116-1133)
- src/server-worker.ts:678-792 — runQuery (decoded rows :752, out-param {where,total,token} :755-759, signature components)
- src/server-worker.ts:1371-1410 — writeFrames TWO encode sites (:1382 pending-append, :1389 fresh)
- src/server-worker.ts:2006-2096 — handleData (threads the memo into dispatchLine)
- src/server-worker.ts:1921+ — startServer closure (memo owner)
- src/server-worker.ts:1324-1329 — readWorldRev (= reducer_state.last_event_id)
- src/protocol.ts:157-164, :311-313 — ResultFrame shape + conditional id; encodeFrame
- src/server-worker.ts:1480-1525, :1700-1704 — diffTick coalescing prior-art (signature key vocabulary; note diffTick's key DELIBERATELY omits sort/limit/offset — the memo's must INCLUDE them)
- src/collections.ts:970-994 — decodeRow; jsonColumns (epics)
- test/server-worker.test.ts:1359-1382 (fakeSock), :1396 (watch seed), :1648/:2102/:1587 (coalescing test prior-art)

### Risks

- **Byte-fidelity is the keystone.** The hand-concat must equal `encodeFrame(runQuery(...))` exactly — conditional `id`, key order, numbers unquoted, `JSON.stringify` on string fields. Prove via equality test on a jsonColumn-bearing epics row FIRST (Early proof point). If it can't be made byte-stable, fall back to cache-decoded-rows + per-conn full re-serialize (shares SELECT+countAndToken, not the serialize).
- **Two writeFrames encode sites** — the backpressure pending-append (:1382) is the easy one to miss; a re-encode there re-stringifies 393KB and defeats the fix. Test the accept=false branch.
- **Stale-rev serve** — the cache write must store under the worldRev read at :1091; the replace-on-mismatch reset must be airtight.
- **Cap must not skip the hot case** — count distinct signatures (21 identical = 1); the large `limit:0` board query must always hit.

### Test notes

Extend test/server-worker.test.ts: (1) byte-fidelity — assert concat line
=== `encodeFrame(runQuery result)` for the same rows across epics (non-empty
`tasks`/`epic_links`), jobs, id-present/id-absent, and empty rows; (2)
single-flight — N fakeSocks with DISTINCT ids + identical signature →
spy/trace counter proves runQuery+stringify ran ONCE, each conn's bytes
identical to the reference; (3) backpressure — accept=false append branch
still emits raw pre-serialized bytes; (4) worldRev advance → cache replaced,
fresh serialize, correct rev; (5) memo-throw → degrades to un-memoized path.
Validate end-to-end with bench-latency + KEEPER_TRACE_SERVER under several
open boards.

## Acceptance

- [ ] per-server-instance memo `{worldRev, entries}` threaded into dispatchLine; replace-on-worldRev-mismatch reset; sigKey = collection+clause+params+sort+dir+limit+offset reusing `seed.where`
- [ ] cache hit serves rows+total+token from the Entry with zero SELECT/countAndToken; only `out.type==="result"` is memoized
- [ ] pre-serialized line byte-identical to `encodeFrame(runQuery(...))` (epics+jobs, id present/absent, empty rows) — equality-tested
- [ ] `writeFrames` short-circuits the `PreSerialized` line at BOTH encode sites; non-query frames unchanged
- [ ] single-flight proven: N identical-signature queries → one runQuery + one stringify (counter)
- [ ] memo wrapped so any throw degrades to un-memoized path; dispatchLine never throws
- [ ] distinct-signature cap never sheds the hot signature; KEEPER_TRACE_SERVER hit/miss/serialize-once lines present
- [ ] README architecture + runQuery JSDoc/call-site updated; full suite green; bench-latency residual band reduced (record in Evidence)

## Done summary

## Evidence
