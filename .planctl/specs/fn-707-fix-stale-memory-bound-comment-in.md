## Overview

The `readFileSync` call in `scanZellijEventsDir` materializes the full file unconditionally, but the adjacent comment claims the read is "bounded by `MAX_ZELLIJ_EVENTS_FILE_BYTES`." That bound applies only to the tail-slice window computed at line 886, not to the read itself. Fix the comment to accurately describe what happens: the full file is read; the cap bounds the consumed tail window; fn-706.2 rotation keeps real feeds well under the cap in practice.

## Acceptance

- [ ] Comment at daemon.ts:888-889 accurately states that readFileSync materializes the full file and MAX_ZELLIJ_EVENTS_FILE_BYTES caps the tail-slice window, not the read.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F4 | kept | .1 | Comment at daemon.ts:888-889 says "bounded by MAX_ZELLIJ_EVENTS_FILE_BYTES" describing the read; readFileSync at line 833 materializes the full file — bound applies only to the tail-slice at line 886. Surprises next reader tracing the memory-bound claim. |

## Out of scope

- debounce map stale entries in tab-namer (tier_0 — not a regression; same shape as pre-existing managed/disowned maps)
- combination test for rotation + oversize cap interaction (tier_0 — implausible trigger; rotation fires at 4 MiB, cap at 16 MiB)
- rotate_write failure branch test (tier_0 — self-healing recovery path; WASI fault injection not available in test harness)
