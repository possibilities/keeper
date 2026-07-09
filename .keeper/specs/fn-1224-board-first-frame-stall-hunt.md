## Overview

Fresh subscribe connections intermittently get no first frame inside the default 2s window — keeper board and keeper status time out or hang while the control RPC socket answers instantly — and the stall recurs across daemon restarts, then vanishes (measured 0.5s on one connection minutes after a 45s-window success and two 2s timeouts). Evidence points at something periodic blocking the serve loop against a grown DB (1.7G file, ~1.07M events rows, ~486k retained bodies): candidate culprits are the five-minute retention pass, WAL checkpointing, another heavy periodic sweep, or an unbounded snapshot read missing its recency bound. Find the stall source with instrumentation, fix that specific blocker, and pin a first-frame regression guard.

## Quick commands

- `keeper board --snapshot` — must deliver frame 1 inside the default window, repeatedly, including while the daemon's periodic passes run
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT COUNT(*) FROM events"` — the table mass the serve path must stay indifferent to

## Acceptance

- [ ] The stall source is identified with evidence and eliminated: repeated default-window snapshot calls deliver a first frame across a window that spans the daemon's periodic passes, on a database of the current production size
