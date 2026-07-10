## Description

Close finding F1 (with merged test gap TG1) from the fn-1228 close audit.
In `cli/transcript.ts` the date-only branch (around lines 221-244 as of commit
dd279623) constructs `new Date(year, month, day, 0,0,0,0)` and guards only on
`Number.isFinite(localMidnight)`. Numeric `Date` components never yield an Invalid
Date — `2026-02-30` normalizes to Mar 2, `2026-13-01` to next January — so the guard
is dead code and out-of-range values silently bound the wrong window. After
constructing the `Date`, validate the round-trip
(`d.getFullYear() === year && d.getMonth() === month && d.getDate() === day`) and
return the existing `invalid --${edge} time '${raw}'; use ISO-8601 or 30m/8h/7d`
error on mismatch. Apply the same check to the `since` and `until`
(next-local-midnight) constructions.

Files: `cli/transcript.ts` (date-only parse branch) and its time-parser test file.

## Acceptance

- [ ] Out-of-range date-only `--since`/`--until` (e.g. `2026-02-30`, `2026-13-01`) returns the `invalid --<edge> time` error.
- [ ] In-range date-only, relative (`30m`/`8h`/`7d`), and ISO-8601 values parse unchanged.
- [ ] A regression test (TG1) asserts the out-of-range case errors, covering both `since` and `until` edges.

## Done summary

## Evidence
