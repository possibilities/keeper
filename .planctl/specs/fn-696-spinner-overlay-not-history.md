## Overview

The shared TUI connecting/loading indicator animates a braille spinner +
re-fold progress every ~125ms by calling `liveShell.pushFrame`, which
records each tick as a data frame in the history ring (cap 500). During a
multi-second connect / boot re-fold this floods frame history with
near-identical "connecting…" frames and runs the banner frame counter up,
making ←/→ history navigation useless. The fix routes the spinner through
the existing non-recording `refreshLive` overlay primitive instead.

## Quick commands

- `bun test test/view-shell.test.ts test/live-shell-core.test.ts`

## Acceptance

- [ ] The connecting spinner repaints via the overlay and does NOT grow
  frame history; first real data frame is `frame 1`.
