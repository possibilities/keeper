## Overview

The close-claim holder liveness probe added by the source epic caps the
darwin `ps -o lstart=,args=` start-time read at `maxBuffer: 4096`. Because
`args=` streams the target's full command line and keeper-spawned workers
routinely carry multi-kilobyte argvs (26KB observed on-host), a recycled-pid
probe overflows the buffer, returns null, and reports the holder liveness as
"unknown" — silently deferring the epic's headline recycle-aware reclaim to
the 24h stale bound. This is a scoped robustness fix to the probe so the
recycle-detection path works for exactly the long-argv worker class it targets.

## Acceptance

- [ ] The darwin start-time probe no longer drops a live/recycled holder to
      "unknown" solely because the target process has a long argv.
- [ ] The probe's buffering matches the sibling convention in `src/seed-sweep.ts`.
- [ ] A regression test exercises a long-argv holder and asserts the probe
      resolves it (alive vs dead recycle) rather than falling through to the stale bound.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | readProcessStartTime maxBuffer:4096 overflows on long-argv (recycled) holders -> null -> "unknown", deferring recycle reclaim to the 24h backstop; sibling seed-sweep.ts imposes no cap and the caller uses only the 24-char lstart. |
| F2 | culled | — | Test-only helper duplication across three files; DRY cleanliness with no user impact. |
| F3 | merged-into-F1 | .1 | F3's null-probe retention test folds into F1 as the regression guard for the maxBuffer fix, same root cause and same commit. |

## Out of scope

- The 24h `CLOSE_CLAIM_STALE_MS` backstop itself (unchanged; it remains the
  fallback for un-probeable and legacy pid-less markers).
- The test-helper deduplication nit (F2, culled) — left as-is.
