## Description

Finding F1 (auditor Should Fix). Evidence: src/bus-worker.ts:1027
`decodeTail` does `new TextDecoder().decode(bytes.subarray(accepted))`,
and is invoked on both partial-write stash sites (:506 in the direct
write path and :526 in `flushQueue`). The tail is re-encoded via
`encoder.encode(frame)` (:515) on the next flush. A short write that
lands mid multi-byte UTF-8 sequence yields a U+FFFD replacement char,
irreversibly corrupting the delivered message. The fix already exists in
this repo: src/server-worker.ts keeps the pending tail as a `Uint8Array`
and re-flushes from a byte offset (`pending.bytes.subarray(offset)` at
:1817; `resumePending`/`flush` at :1846/:1855) — never decoding
mid-stream. Carry the bus queue tail as bytes + offset rather than as a
decoded string.

## Acceptance

- [ ] The partial-write tail is queued as bytes (or bytes+offset) and re-flushed without a TextDecoder round-trip; `decodeTail` is removed or no longer decodes a partial frame.
- [ ] A new test feeds a non-ASCII (multi-byte) body through a forced short write that splits a UTF-8 sequence and asserts the reassembled delivery is byte-identical to the source.
- [ ] Existing bus integration tests (directed/broadcast/anti-spoof/0600/shutdown) stay green; test:full passes.

## Done summary

## Evidence
