## Overview

The Agent Bus relay's backpressure path decodes a partial socket-write tail
back to a string and re-encodes it on the next flush. A short write that
splits a multi-byte UTF-8 sequence (markdown, emoji, non-Latin bodies — all
routine bus traffic) turns the split bytes into a U+FFFD replacement char,
silently corrupting the delivered message. This is a bug fix: carry the
queued tail as bytes and re-flush from an offset, mirroring the proven
byte-offset stash already in src/server-worker.ts.

## Acceptance

- [ ] Partial-write tail is queued and re-flushed as bytes, never round-tripped through a string decode/encode.
- [ ] A multi-byte UTF-8 body split across a short write is delivered byte-identical to its source.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | bus-worker.ts:1027 decodeTail decodes a partial-write tail to a string (called :506/:526), so a split multi-byte UTF-8 sequence becomes U+FFFD and corrupts non-ASCII bodies on the wire. |
| F2 | culled | — | bus-worker.ts:547-553 terminate?.() cast is dead but harmless — evict nulls sock/clears queue/deletes the entry before close; remedy is a comment reword only. |
| F3 | culled | — | bus-worker.ts:606 synthetic start_time duplicate-channel case is a transient keeper-fold-gap edge the 90s reaper self-heals non-destructively. |
| F4 | culled | — | cli/bus.ts:484 fixed 50ms flush delay is a theoretical race on a one-shot localhost UDS write of one small frame; no realistic user impact. |

## Out of scope

- The bus authority model / laundered-authority residual (Security Notes — explicit human-owned design decision, no action required).
- watch reconnect-backoff coverage and the fold-gap duplicate-channel case (culled findings F3 and the associated test gaps).
