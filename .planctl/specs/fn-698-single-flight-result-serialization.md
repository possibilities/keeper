## Overview

The last measured TUI-latency tail (~350-420ms p90-p99, after fn-694 +
fn-697) is serialize-on-the-event-loop: the server-worker answers each
client `query` with its own synchronous SELECT + `JSON.stringify` in
`dispatchLine`→`runQuery`→`writeFrames`, so ~21 keeper-board subscribers
refetching `subagent_invocations` (~393KB) after a fold run 21 serializes
back-to-back while a ready jobs patch waits behind them. fn-697's diffTick
PATCH path already coalesces; the QUERY-ANSWER path does not.

This epic adds a per-world-rev result memo: when N connections issue an
identical query (same collection + resolved filter + sort + limit + offset)
at the same `worldRev`, the FIRST runs `runQuery` + `JSON.stringify(rows)`
once and caches `{rows, rowsJson, total, token, where}`; the rest reuse it,
each getting a pre-serialized result LINE (per-conn envelope concatenated
around the shared `rowsJson`). Collapses 21× SELECT+serialize into 1× +
21× cheap concat. No wire-protocol change (bytes identical), no schema
change, no new write surface — a pure read/serve-path optimization. None of
it touches a fold, so re-fold determinism is not in play.

## Quick commands

- `bun scripts/bench-latency.ts --duration 30` — measure jobs+epics surfacing before/after; open several `keeper board` instances to reproduce the ~21-subscriber storm (target: the residual ~350ms p90 band)
- `bun test test/server-worker.test.ts` — the single touched suite (byte-fidelity + single-flight + backpressure-append tests)
- `KEEPER_TRACE_SERVER=1` on the daemon + a bench run — confirm one serialize per (signature, worldRev) via the new hit/miss/serialize-once stage lines

## Acceptance

- [ ] N identical-signature queries at one worldRev → exactly ONE runQuery + ONE JSON.stringify (proven by a spy/trace counter); a cache hit runs zero SELECTs (rows + total/token served from the entry)
- [ ] Each connection's pre-serialized result line is BYTE-IDENTICAL to today's `encodeFrame(runQuery(...))` — verified by equality assertion across a jsonColumn-bearing collection (epics) AND a plain one (jobs), with `id` present, `id` absent, and empty rows
- [ ] worldRev advance replaces the cache; no line stamped rev-N+1 ever carries rev-N rows
- [ ] `writeFrames` writes the pre-serialized line verbatim at BOTH encode sites (fresh + backpressure pending-append); every non-query frame still goes through `encodeFrame` unchanged
- [ ] memo is per-server-instance (not module-global); any memo-path throw degrades to the un-memoized runQuery+encodeFrame path — `dispatchLine` still never throws
- [ ] distinct-signature cap never sheds the hot board signature; bench-latency shows the residual ~350ms band measurably reduced under multi-board load
- [ ] docs updated (README ## Architecture server-worker paragraph + runQuery JSDoc/call-site); no CLAUDE.md change (read-path only)

## Early proof point

Prove byte-fidelity FIRST: an equality test asserting the hand-concatenated
line === `encodeFrame(runQuery(result))` for the same decoded rows, on an
epics row with non-empty `tasks`/`epic_links` (the jsonColumn round-trip is
the riskiest fidelity case). If that can't be made byte-stable: fall back to
caching the decoded rows + per-conn `JSON.stringify(frame)` — shares the
SELECT + countAndToken but not the serialize (a partial win without the
concat-fidelity risk).

## References

- fn-697-cut-board-subagent-refetch-storm (immediate predecessor; its diagnosis scoped this band) and fn-694-reduce-tui-surface-latency
- fn-2-keeper-uds-subscribe-server — runQuery / writeFrames / diffTick origin
- Prior-art in-repo: diffTick's shared-selectByIds coalescing + filter-signature grouping (`src/server-worker.ts` :1480-1525, :1700-1704) — the memo is the same idea one level up, at the query-answer seam
- scripts/bench-latency.ts — before/after harness (multi-board load reproduces the storm)

## Docs gaps

- **README.md `## Architecture`** (server-worker paragraph, ~:978-1014): extend the existing "sharing one query across same-filter clients" sentence to note the per-worldRev result memo (N conns, same query, same worldRev → one SELECT+serialize, per-conn envelope assembly). Fold into the sentence; don't add a paragraph.
- **src/server-worker.ts**: `runQuery` JSDoc (~:650-677) + the call-site comment (~:1101) — runQuery itself is unchanged; the call site wraps it in the memo so repeated identical calls within a worldRev collapse.
- **src/protocol.ts**: `ResultFrame` JSDoc (~:147-164) — OPTIONAL one-line "may be served pre-serialized; frame shape unchanged" (low priority; skip if protocol.ts is treated as pure wire-shape doc).

## Best practices

- **Read worldRev BEFORE the SELECT, key on that value:** keeper already reads `worldRev` at :1091 before `runQuery` :1101 — the cache write MUST store under that same value, never a re-read (TOCTOU: rows at N+1 cached under N).
- **Key by worldRev (`reducer_state.last_event_id`), NOT `PRAGMA data_version`:** data_version moves on RPC-writer/checkpoint without a projection change and has a same-connection blind spot; worldRev is the projection-truth axis, bumped in-transaction on every fold.
- **Concatenate AROUND the blob, never double-encode:** `'{"type":"result"…,"rows":' + rowsJson + '}'` where `rowsJson` is the unmodified `JSON.stringify(rows)` output. `JSON.stringify` the `id` (typed `string`, not guaranteed UUID) and `collection` for byte-fidelity; conditionally insert the `"id":…,` segment exactly when `frame.id !== undefined`.
- **Cache decoded rows + rowsJson from ONE source:** the byte invariant is "identical to today's `encodeFrame(runQuery(...))`", not "identical to stored TEXT" — serialize the SAME decoded array runQuery returns; treat the cached array read-only (the SubState seed copies it via `new Set`/`new Map`).
- **Memo path must never throw:** `dispatchLine` is no-self-heal; wrap the lookup/build so any bug degrades to the un-memoized path.
