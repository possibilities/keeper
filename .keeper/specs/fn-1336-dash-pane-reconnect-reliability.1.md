## Description

**Size:** S
**Files:** src/readiness-client.ts, test/readiness-client.test.ts

### Approach

The subscribe driver's data handler decodes each chunk statelessly, mangling
a multibyte sequence split across reads. Adopt the server's per-connection
streaming TextDecoder shape: a fresh decoder per dial (like the existing
per-connection LineBuffer), lenient posture (U+FFFD, never throws), partial
tail discarded on reconnect so a dead socket's torn bytes never bleed into
the new stream's first line. Newline framing is single-byte-safe, so this is
pure data fidelity — no framing change. Re-evaluate the surrounding
try/catch after the change and keep only what still has a live purpose.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/readiness-client.ts:1554 — the stateless decode inside the data handler; :1522-1570 connectOnce (where the per-dial decoder belongs, beside the fresh LineBuffer)
- src/server-worker.ts:3668 decodeConnChunk + flushConnDecoder — the shape to mirror

**Optional** (reference as needed):
- test/server-worker.test.ts:281 — the snowman-split regression template to port

### Test notes

Port the split-multibyte template: a frame split mid-character across two
data events decodes intact; a torn tail from a killed dial is absent from
the next dial's first frame.

## Acceptance

- [ ] A multibyte character split across data events decodes intact through the subscribe driver
- [ ] A reconnect discards the prior dial's partial decode tail
- [ ] The readiness-client test gate passes

## Done summary

## Evidence
