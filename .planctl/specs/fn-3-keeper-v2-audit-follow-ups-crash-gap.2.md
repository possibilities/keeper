## Description

Audit finding `max-line-bytes-code-units` (tier-1, source epic `fn-2-keeper-uds-subscribe-server`).

`MAX_LINE_BYTES` in `protocol.ts` (line 140) is named and documented as a byte cap, but all three enforcement sites use `string.length` — which returns UTF-16 code units, not bytes. For ASCII JSON frames the difference is zero, but the constant name, `OversizedLineError` message, and doc comment all say "bytes" while `pendingBytes()` already has a parenthetical `(UTF-16 code units; fine for the cap check)` acknowledging the gap without fixing it. This misleads future maintainers.

Fix: rename `MAX_LINE_BYTES` → `MAX_LINE_LENGTH` throughout `src/protocol.ts`. Update:
- The constant declaration and doc comment: replace "bytes" with "characters" / "code units".
- The `OversizedLineError` message: replace "bytes" with "characters".
- `pendingBytes()` → `pendingLength()` with an accurate doc comment.
- All three cap-check call sites update automatically via the rename.

No behavior change — same cap value, same code-unit measurement, just honest naming.

## Acceptance

- `MAX_LINE_BYTES` is gone from `src/protocol.ts`; `MAX_LINE_LENGTH` is the exported constant.
- `OversizedLineError` message does not contain the word "bytes".
- `pendingBytes()` is renamed to `pendingLength()` with a doc comment that does not claim byte semantics.
- `grep -r MAX_LINE_BYTES src/` returns nothing.
- `bun test` passes (pure rename, no behavior change, no test updates required).

## Done summary
Renamed MAX_LINE_BYTES to MAX_LINE_LENGTH and pendingBytes() to pendingLength() in src/protocol.ts; updated doc comments and OversizedLineError message to say 'characters' (UTF-16 code units). Pure rename, no behavior change.
## Evidence
