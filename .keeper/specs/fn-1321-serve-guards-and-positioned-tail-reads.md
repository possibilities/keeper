## Overview

Four verified hardening items on the serve/daemon read surfaces: a
per-connection stateful utf8 decoder at the serve worker's one socket
decode site (split multi-byte codepoints currently corrupt to U+FFFD); a
minimum-sample floor making the full-replay projection null below 1000
folded events (tiny quiet-boot samples inflate ~15x — ADR 0075 amended in
place); positioned byte reads in the events-log ingester (today every
tick re-reads and re-decodes each whole NDJSON file); and an unmistakable
view-shell DISCONNECTED state rendered through already-recognized styling
in BOTH paint paths. The backup auto_vacuum backlog claim was RETIRED at
plan time — verified as deliberate, documented, self-verified design.

## Quick commands

- `bun test ./test/status.test.ts` — the pure projection suite incl. the new floor cases
- `bun test ./test/events-ingest-worker.test.ts` — the ingester suite incl. positioned-read edges; the byte-parity case must stay green
- `bun test ./test/view-shell.test.ts` — the disconnected-state transitions

## Acceptance

- [ ] A multi-byte codepoint split across socket chunks decodes intact; connection close discards any buffered partial codepoint without dispatching it
- [ ] The full-replay projection reads null below the 1000-folded-events floor; the catch-up leg is unfloored and unchanged; ADR 0075's null contract stays single-sourced
- [ ] The ingester reads only unread bytes per tick via a positioned read (fd fstat-verified, short-read looped, finally-closed) with byte-identical folded output
- [ ] Post-grace disconnection renders an unmistakable DISCONNECTED indication in both TTY and passthrough paths; the spinner and flash-restore respect it; ADR 0019 carries the supersession note

## Early proof point

Task that proves the approach: ordinal 3 (the positioned read against the
~40-case ingester suite incl. byte-parity). If positioned reads can't hold
byte-parity: keep whole-file reads and land only an incremental decode of
the sliced tail, re-scoping the win to decode cost.

## References

- docs/adr/0075 (amend the null-condition bullet in place for the floor); docs/adr/0019 (records the current pill UX — needs the supersession note)
- Verification deltas vs the backlog: utf8 has ONE reader site (not five); backup auto_vacuum coupling is deliberate design (retired); the ingester claim held exactly
- The shim SGR parser strips unrecognized codes incl. INVERSE — the loud signal must use the already-recognized red bucket + a plain-text token (both-paths rendering, no new paint capability)
- The glossary lists "reconnect" as an Avoid synonym — the user-visible token is DISCONNECTED; code-internal identifiers unchanged
- Sibling wave-1 epics (commit-work/bus rail; src/agent/**) are surface-disjoint by construction; the wave-2 module-split epic will carry a depends_on_epics edge on this one

## Docs gaps

- **docs/adr/0075**: amend the full-replay null-condition bullet in place (floor joins non-positive work) — owned by ordinal 2
- **docs/adr/0019**: supersession note for pill → unmistakable DISCONNECTED — owned by ordinal 4

## Best practices

- **One TextDecoder per stream, final flush on close** (a shared or per-chunk decoder corrupts; a missing flush silently drops a tail) [whatwg/MDN]
- **Byte offsets, never string length** — advance by bytesRead; fstat the open fd; loop short reads; finally-close [Node/Bun docs, Filebeat registry patterns]
- **Dim is a documented terminal gap and INVERSE is stripped by the shim** — loud state = recognized color bucket + plain-text token, sticky-attr resets, existing TTY gating [terminfo.dev + repo shim contract]
