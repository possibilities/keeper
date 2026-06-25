## Description

Source findings: F1 (kept) and TG1 (merged-into-F1).

F1 evidence path: src/tmux-control-worker.ts:724 (`runConnection` reader
loop) calls `resolveFirstChunk()` unconditionally after any non-empty chunk
that yields >=1 complete line. Because `parseControlStream` is whole-
transcript pure and the reader feeds complete lines per chunk, a `%begin`
whose matching `%end` lands in the NEXT `reader.read()` leaves the parser
InBlock with no `reply` event emitted for the unsolicited attach handshake
block — yet the bootstrap is already released to send its first command via
`firstChunk` (lines 646-653). The bootstrap's reply resolver (pushed at
line 668) can then FIFO-match against the handshake block's eventual `%end`
at `settleHead` (line 628), mis-correlating one reply and posting a wrong
focus observation. Gate the bootstrap release on having actually drained one
complete `reply` event (the empty-queue unsolicited reply) rather than on
"processed a chunk with a line", making the drop deterministic regardless of
read boundaries.

TG1 evidence path: the `ControlChild` injection seam (src/tmux-control-worker.ts:325)
exists precisely to feed a fake-transcript child (plain ReadableStream +
write/flush stdin, no real fork). The intricate dirty/redirty/handshake-drop
state machine (lines 634-760) currently has no fast-tier synthetic-child
coverage — only pure seams (fast tier) and a real `tmux -C` attach (slow
tier). Add the fast-tier test that drives a scripted transcript through this
seam to pin the fix: it covers the same handshake-drop region as F1, so it
lands in the same commit.

## Acceptance

- [ ] `resolveFirstChunk` (or its replacement) releases the bootstrap only
      after one complete reply event has drained with an empty queue (the
      unsolicited handshake block), not after a mere chunk-with-line.
- [ ] A handshake whose `%end` splits into a later `read()` does NOT release
      the bootstrap early and does NOT mis-correlate the first command reply.
- [ ] A fast-tier synthetic-child test feeds a scripted transcript through
      the `ControlChild` seam asserting the handshake drop, the no-mis-match
      FIFO correlation, and exactly-one redirty re-read re-arming.
- [ ] `bun run test:full` is green (touches the worker/git process path).

## Done summary
Gate the tmux control bootstrap release on the unsolicited attach handshake reply fully settling (via a connection-scoped stateful parser that reassembles a split %begin/%end), not on a mere chunk-with-line, so no reply is mis-correlated. Added a fast-tier synthetic-child test over the ControlChild seam pinning the split-handshake drop, FIFO no-mis-match, and exactly-one redirty re-arm.
## Evidence
