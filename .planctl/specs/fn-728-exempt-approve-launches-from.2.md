## Description

**Size:** M
**Files:** cli/autopilot.ts, test/autopilot.test.ts

### Approach

Delete the `keeper autopilot` viewer's client-side cap simulation — it
re-implements reconcile logic and would diverge from the server after the
worker change. Remove `predictNextDispatches` (:228), `predictFullSchedule`
(:584), and their private helpers ONLY IF genuinely orphaned: `ScheduleStep`
(:447), `PreviewSections`/`PreviewRow` (:150-166), `previewRowFromTask`/
`previewRowFromEpic` (:175-202). Remove the `predicted`/`schedule` fields
from `RenderInput` (:896-907) and the `--- predicted ---` (:943-967) and
`--- schedule ---` (:969-981) blocks in `renderBody`. At the single call
site (:1236-1262), stop computing `predicted`/`schedule` (:1237-1241) and
drop them from BOTH the `renderBody({...})` arg and the `stateJson` object
(:1245-1260).

**KEEP `projectMaxConcurrentJobs` (:879)** — it is NOT orphaned; it backs
the `· max N` banner via `autopilotBannerLabel` (:1199) / the subscribe
handler (~:1316). Keep the `current`, `stopped`, `failed`, and
`dependencies` sections of `renderBody`, plus `buildCurrentRows` (:793) and
`renderDependencyGraph` (:714), fully intact.

Before deleting each private helper, grep it across the file to confirm the
RETAINED sections (current/stopped/failed/dependencies/banner) don't use it;
delete only the genuinely-unused ones.

### Investigation targets

**Required** (read before coding):
- cli/autopilot.ts:150-202 — `PreviewSections`/`PreviewRow`/`previewRowFrom*` (verify orphaned)
- cli/autopilot.ts:228, :584 — `predictNextDispatches` / `predictFullSchedule`
- cli/autopilot.ts:879, :1199, ~:1316 — `projectMaxConcurrentJobs` + `autopilotBannerLabel` + subscribe handler (KEEP — banner)
- cli/autopilot.ts:896-981 — `RenderInput` interface + `renderBody` (which blocks go, which stay)
- cli/autopilot.ts:1236-1262 — the single call site; predicted/schedule threaded into BOTH bodyLines and stateJson
- test/autopilot.test.ts:361-555 — all `renderBody({...})` calls (`:361,376,410,481,500,555,904,930`) pass the non-optional `predicted` field
- test/autopilot.test.ts:589-705 (`predictNextDispatches`), :803-864 (`projectMaxConcurrentJobs` — KEEP these tests), :956+ (`predictFullSchedule`)

### Risks

- **`projectMaxConcurrentJobs` is load-bearing for the banner** — deleting it (or its tests) breaks `· max N`. Keep both.
- **`RenderInput.predicted` is non-optional** — removing it is a signature change; EVERY `renderBody({...})` call (prod + all ~8 test calls) must drop the field in the same commit or the build breaks, not just the two asserting `--- predicted ---`.
- **Shared-helper over-deletion** — `PreviewSections`/`ScheduleStep`/`previewRowFrom*` are believed prediction-only; confirm by grep before removing so a retained section isn't broken.
- **`stateJson` contract** — confirm no external reader consumes the `predicted`/`schedule` JSON fields from the rendered frame before dropping them (repo grep found no function consumers; the JSON field is a separate surface).

### Test notes

- Delete the `predictNextDispatches` and `predictFullSchedule` test groups.
- KEEP the `projectMaxConcurrentJobs` test group (:803-864) — banner still uses it.
- Rewrite the two `renderBody` tests that assert `--- predicted ---` (:409, :499) to the current/stopped/failed/dependencies shape; update every other `renderBody({...})` call to drop the `predicted` field.
- `bun test test/autopilot.test.ts` passes; `keeper autopilot` renders no predicted/schedule sections but still shows the `· max N` banner.

## Acceptance

- [ ] `predictNextDispatches`/`predictFullSchedule` and their orphaned-only helpers are removed; no dangling refs
- [ ] `projectMaxConcurrentJobs` and the `· max N` banner are retained and still work
- [ ] `RenderInput` no longer carries `predicted`/`schedule`; every `renderBody` call site (prod + tests) compiles
- [ ] `renderBody` keeps current/stopped/failed/dependencies; predicted/schedule blocks gone
- [ ] `bun test test/autopilot.test.ts` passes; viewer eyeball confirms sections removed, banner intact

## Done summary

## Evidence
