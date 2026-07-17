## Description

**Size:** S
**Files:** src/server-worker.ts, test/server-worker.test.ts

### Approach

The serve worker's single inbound decode site converts each socket
Buffer independently, so a multi-byte codepoint split across chunk
boundaries corrupts to replacement characters before the line framer
ever sees it. Give each connection a stateful streaming decoder living
beside its line buffer in the per-connection state (minted where that
state is constructed), decode every chunk in stream mode with
fatal:false (a hostile byte degrades to U+FFFD and the existing
per-line bad-frame path answers it — never a thrown batch), and on
connection teardown perform the final non-stream flush and DISCARD its
output — a dead peer's buffered partial codepoint is at most one
incomplete character with no newline, never a dispatchable frame. The
teardown hook runs from both the async close handler and the
synchronous cap-sweep evict, so the flush must be idempotent. The
string-level line framer in the protocol module must not change — it
is the wrong layer and is imported by many call sites.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/server-worker.ts:3887 — the one decode site (chunk.toString) inside handleData
- src/server-worker.ts:1017-1073 — ConnState + newConnState (the decoder's home, beside `buffer: LineBuffer`)
- src/server-worker.ts:2768-2790 — freeConn (idempotent, called from close :3818 AND evictConn :2782 — the flush's double-call reality)
- src/protocol.ts:601-615 — LineBuffer (string-level; MUST NOT change)

**Optional** (reference as needed):
- src/server-worker.ts:3704-3836 — the open/close handler pair and the cap-reject paths that mint ConnState before conns.add

### Risks

- stream-mode is a decode-call option, not a constructor option — a mixup surfaces only at runtime in the worker
- The flush must never route to dispatchLine — an unanswerable corrupt frame for a dead peer

### Test notes

In-process: feed a multi-byte codepoint split across two pushes through
the connection-state seam and assert intact decode; a boundary-split
followed by close asserts the tail is discarded (no dispatched frame);
double-teardown asserts idempotency.

## Acceptance

- [ ] A codepoint split across two socket chunks reaches the line framer intact (no replacement characters at chunk boundaries)
- [ ] Malformed bytes degrade to replacement characters handled by the existing bad-frame path; no batch is dropped and nothing throws
- [ ] Connection teardown flushes and discards any buffered partial codepoint, idempotently across both teardown paths
- [ ] The full fast correctness gates stay green

## Done summary

## Evidence
