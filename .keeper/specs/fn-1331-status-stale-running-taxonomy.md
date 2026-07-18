## Overview

`keeper status` counts collapse every running subtype into one bucket while the
board renderer already distinguishes stale-running (warn) from live running. This
epic surfaces the stale split in the status counts and JSON envelope additively,
records the `running_jobs` deprecation decision in an ADR (docstring-deprecated,
kept emitting — no wire break), and keeps cached staleness honest by co-displaying
evidence freshness rather than confident present tense.

## Quick commands

- bun test ./test/status.test.ts && bun test ./test/board.test.ts
- keeper status --json | jq '.data.counts'

## Acceptance

- [ ] Status counts render stale-running distinctly from live running, consistent with the board pill taxonomy
- [ ] `running_jobs` keeps emitting, documented deprecated in favor of `board_work_jobs`, with the decision recorded in a new ADR
- [ ] Stale states co-display last-evidence freshness rather than bare present tense

## Early proof point

Task ordinal 1 is the whole epic; its first commit-worthy step is the tally split
with the fixture proving stale/live separation. If the verdict input cannot carry
the subtype without touching the readiness verdict shape: extend the shape
minimally — the epic dep on the hygiene epic already serializes the shared file.

## References

- cli/status.ts:296-317 tallyVerdicts (flattens); :397-403 runningJobs vs boardWorkJobs; :461-462 emission; :74-119 schema doc
- src/board-render.ts:571-628 bucketForToken — the existing stale/live pill split to mirror
- src/readiness-client.ts:2401-2417 — injected stale reference timestamp (pure pass never reads wall-clock)
- Epic deps: fn-1326 (test/status.test.ts fixture + served-field collision), hygiene epic (potential readiness.ts verdict-shape overlap)

## Docs gaps

- **docs/adr/ (new record)**: running_jobs deprecation model + the stale-running count taxonomy (STATUS_SCHEMA_VERSION implications)
- **CONTEXT.md**: a stale-running glossary entry only if naming blocks the worker
