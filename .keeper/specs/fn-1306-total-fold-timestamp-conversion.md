## Overview

The reducer's event-timestamp-to-ISO conversion calls Date toISOString unguarded inside folds — a malformed or out-of-range event timestamp throws inside the fold, violating the never-throw fold invariant and dead-lettering events that should fold safely. Make the conversion total: any invalid input yields a deterministic fallback string and the fold proceeds.

## Quick commands

- `bun test ./test/reducer-projections.test.ts` — fold-totality coverage green

## Acceptance

- [ ] A fold consuming an event with a malformed, NaN, or out-of-range timestamp completes without throwing and advances the cursor
- [ ] Valid timestamps convert byte-identically to today's output (re-fold determinism preserved)
