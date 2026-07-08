## Overview

The retention sweep is reporting its own data-loss detector firing:
`retention BUG: 13052 keep-set event(s) have a NULL body — data loss, NOT legitimate
retention` (server.stderr). Events inside the keep window (which retention must never
strip) have NULL bodies — either a prior retention pass overshot its watermark, a writer
minted body-less events, or the keep-set/watermark computation is wrong. Investigate which,
fix the cause, and decide what recovery (if any) is possible for the already-stripped rows.

## Quick commands

- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT COUNT(*) FROM events WHERE body IS NULL AND id > <keep-watermark>"` — the detector's own count, re-checkable

## Acceptance

- [ ] Root cause identified and stated (overshoot vs body-less mint vs wrong keep-set derivation)
- [ ] The cause is fixed with a regression test in the retention suite
- [ ] The BUG log line no longer fires on a healthy DB; already-lost bodies documented as unrecoverable or recovered

## Early proof point

Task ordinal 1. If the loss traces to re-fold-relevant events (the deterministic projection
class replays from bodies), STOP and page the operator before any further retention runs —
that changes severity from cosmetic to replay-breaking.

## References

- server.stderr line: "retention: shed 225 cold body/bodies ... reclaimed 108 page(s)" immediately preceding the BUG line — the sweep and detector in the same tick
