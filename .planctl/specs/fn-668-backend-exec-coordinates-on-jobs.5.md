## Description

**Size:** S
**Files:** src/collections.ts, cli/jobs.ts, src/board-render.ts, src/view-shell.ts, README.md

### Approach

Surface the coords read-only on both `keeper jobs` and the TUI through the shared renderer. Add the five `backend_exec_*` columns to `JOBS_DESCRIPTOR.columns` as display-only (like `profile_name` — NOT in sortable/filters/jsonColumns). Extend `projectJobRow` to carry them and `formatJobLine`/`renderJobsBody` to append a restrained, dim, present-only single segment (e.g. `· zellij <session>/<tab_name> p<pane>`), rendering nothing when coords are absent — one edit lights up CLI and TUI since both share these helpers. Confirm `src/view-shell.ts` picks it up via the shared `renderBody` callback. Update README: weave the new columns into the sparse-signals paragraph with a schema-v48 tag, add the new producer thread to the worker inventory, add an "As of schema v48" changelog block, and update the `keeper jobs` example-clients bullet.

### Investigation targets

**Required** (read before coding):
- src/collections.ts:87-158 — JOBS_DESCRIPTOR.columns (display-only add; profile_name at :125 is the precedent)
- cli/jobs.ts:141-153 — projectJobRow; :166-196 — renderJobsBody (shared); :303,319 — CLI + TUI call sites
- src/view-shell.ts:73,285 — renderBody callback (confirm TUI inherits the segment)
- README.md:1-67 (sparse signals), ~557-580 (keeper jobs bullet), ~769-791 (worker inventory), ~792-1050 (schema changelog prose)

### Risks

- Table-width blowup: prefer one composed dim segment over five always-on columns; gate a `--wide` breakout only if asked.
- Absent coords must render as nothing/em-dash, never `undefined`.

### Test notes

Snapshot/format test for `formatJobLine` with and without backend coords (present-only segment, graceful absence). Verify `keeper jobs` output by eye on live rows.

## Acceptance

- [ ] Five columns added to JOBS_DESCRIPTOR.columns as display-only; `projectJobRow` carries them.
- [ ] `formatJobLine`/`renderJobsBody` render a dim present-only backend segment on BOTH `keeper jobs` CLI and TUI; absent coords render gracefully.
- [ ] README updated (sparse signals + worker inventory + schema-v48 changelog + keeper jobs bullet).
- [ ] Format test green; no sort/filter behavior added.

## Done summary

## Evidence
