## Description

**Size:** M
**Files:** src/types.ts, src/reducer.ts, src/db.ts, src/readiness.ts, scripts/board.ts, CLAUDE.md, README.md, test/reducer.test.ts, test/db.test.ts, test/board.test.ts, test/readiness.test.ts

### Approach

Server-first, then consumers. Eight steps:

**(1) Widen the type.** In `src/types.ts`, extend `JobLinkEntry` to
`{kind, job_id, title, state, rate_limited_at}`. The pure
classifier in `src/plan-classifier.ts` stays thin (its `JobLink`
output remains `{kind, job_id}`) — enrichment happens at the
reducer's write boundary so the classifier stays a pure function
of events.

**(2) Shared enrichment helper.** Extract
`enrichJobLink(db, classifierEntry): JobLinkEntry` in
`src/reducer.ts`. Takes a `{kind, job_id}` from the classifier,
SELECTs the current `jobs` row by PK, returns the widened entry
with `(title, state, rate_limited_at)` populated. Missing row →
defaults `{title: null, state: "stopped", rate_limited_at: null}`.
Never throws.

**(3) Thread enrichment through `syncPlanctlLinks`.** Between
`deriveJobLinks` and `JSON.stringify` (reducer.ts:1745 area),
map each classifier entry through `enrichJobLink` before
`sortJobLinks` + stringify.

**(4) Add `syncJobLinksOnJobWrite(db, jobId)`.** SELECTs
`jobs.epic_links` for the given `job_id`; if `'[]'`,
short-circuit; otherwise iterate target epic ids, for each epic
RMW `epics.job_links` — parse, filter out the matching `job_id`,
push freshly-enriched entry via `enrichJobLink`, re-sort via the
existing `sortJobLinks`, JSON.stringify, UPDATE. Use the shell-
insert pattern (`INSERT ... ON CONFLICT(epic_id) DO UPDATE`) for
missing epic rows. Mirror the structure of `syncJobIntoEpic`
step-for-step.

**(5) Wire `syncJobLinksOnJobWrite` at every reducer call site
that currently calls `syncIfPlanRef`.** Those are the sites where
`jobs.{title,state,rate_limited_at}` can change. The new fan-out
has its OWN gate (`epic_links !== '[]'`) — it is NOT piggybacking
on `plan_ref` (creator/refiner sessions can have `plan_ref=null`,
e.g. arthack-driven manual sessions running `planctl epic-create`).
All writes inside the open `BEGIN IMMEDIATE`.

**(6) Schema bump + migration.** `SCHEMA_VERSION = 21` in
`src/db.ts`. Add a version-guarded backfill block in `migrate()`
that re-derives every epic's `job_links` using the SAME
`enrichJobLink` + `sortJobLinks` helpers as the live reducer —
byte-identical re-fold is non-negotiable. Orphan entries (job_id
with no `jobs` row) retain with defaults (preserves re-fold
determinism). Mirror the v19→v20 backfill template at
db.ts:1515.

**(7) Migrate consumers.** `src/readiness.ts`
`anyJobLinkRunning(epic, jobs)` becomes `anyJobLinkRunning(epic)`;
reads `link.state === "working"` directly. Update the two callers
at readiness.ts:221 and :306 to drop the `jobs` arg.
`scripts/board.ts` `renderJobLinkLines(jobsById, jobLinks)`
becomes `renderJobLinkLines(jobLinks)`; drop the
`hit === undefined` branch entirely; render every entry as
`   ${title ?? job_id} [${kind}] [${state}]${rateLimitedPillSeg(rate_limited_at)}`
(use `job_id` as a fallback for null title to preserve the line
shape when title is genuinely unknown). Update the single call
site at scripts/board.ts:382.

**(8) Docs.** `src/types.ts` `JobLinkEntry` JSDoc; `scripts/board.ts`
HELP text (the creator/refiner-line grammar paragraph) and
`renderJobLinkLines` JSDoc; `CLAUDE.md` `syncPlanctlLinks`
invariant bullet; `README.md` schema-version prose around line 410
and the example query around line 510.

### Investigation targets

**Required** (read before coding):
- `src/types.ts:35` — `JobLinkEntry` interface; widening lands here.
- `src/plan-classifier.ts:155` and `:389` — `JobLink` interface and `deriveJobLinks`; STAYS THIN — do not widen.
- `src/reducer.ts:1196` — `JobsRowForSync` (has every field needed for enrichment; reuse).
- `src/reducer.ts:1295` — `syncJobIntoEpic` (template for the new jobs-write fan-out helper).
- `src/reducer.ts:1457` — `syncIfPlanRef` (wrapper called from every jobs-write branch; mirror the call-site pattern).
- `src/reducer.ts:1518` — `sortJobLinks` (sort key unchanged).
- `src/reducer.ts:1580` and `:1745` — `syncPlanctlLinks` and the JSON.stringify seam where enrichment threads in.
- `src/reducer.ts:1764` — shell-insert pattern; mirror in `syncJobLinksOnJobWrite`.
- `src/db.ts:56` — `SCHEMA_VERSION` constant.
- `src/db.ts:411` — `CREATE_EPICS` (column type unchanged; entry shape changes).
- `src/db.ts:1515` — v19→v20 backfill block (canonical template).
- `scripts/board.ts:289` and `:382` — `renderJobLinkLines` definition and sole call site.
- `src/readiness.ts:548`, `:221`, `:306` — `anyJobLinkRunning` and its two callers.

**Optional** (reference as needed):
- `src/types.ts:177` — `Job` interface (source of the three fields).
- `src/reducer.ts:428` — `EpicSnapshot` ON CONFLICT carve-out (already preserves `job_links` opaquely; verify widened shape rides through).
- `test/reducer.test.ts:2837` — `syncPlanctlLinks` test fixtures and `getJobLinks` helper.
- `test/reducer.test.ts:2600` — `syncJobIntoEpic` jobs-write fan-out test (template for new fan-out test).
- `test/reducer.test.ts:3121` — `EpicSnapshot` carve-out test.
- `test/reducer.test.ts:3159` — re-fold determinism test (mirror for widened shape).
- `test/db.test.ts:2316` — v19→v20 migration backfill test (template).
- `test/board.test.ts:96` — `makeEpic({job_links})` fixture builder.

### Risks

- **Re-fold determinism break.** Different code paths between the live reducer and the migration backfill producing the same JSON is the classic silent break. Mitigation: single `enrichJobLink` helper used by both.
- **Call-site coverage.** Missing one jobs-write reducer branch = silent staleness for that event type. Mitigation: enumerate the existing `syncIfPlanRef` call sites (reducer.ts:1859, 1933, 1953, 1972, 2028, 2060, 2151 per repo-scout) and wire `syncJobLinksOnJobWrite` alongside each.
- **Hook insert starvation.** The fan-out adds one SELECT+UPDATE per epic referencing a job_id, per jobs-write. At k=1-3 epics per session this is negligible; if a session ever links into 20+ epics the latency could matter. Mitigation: short-circuit on `epic_links === '[]'`; profile if real-world k grows.
- **EpicSnapshot ON CONFLICT carve-out** already preserves `job_links` opaquely; verify with a test that the widened shape survives a snapshot fold (snapshot does not blank enrichment).

### Test notes

- Extend `test/reducer.test.ts` `getJobLinks` helper to parse and assert the new fields.
- Add a "jobs-write re-stamps `job_links` on every linked epic" test parallel to the `syncJobIntoEpic` carve-out test at reducer.test.ts:2600. Cover: state flip on UserPromptSubmit, title update on TranscriptTitle, rate_limited_at set on RateLimited and cleared on revival.
- Add a re-fold determinism test for the widened shape: rewind cursor + `DELETE FROM jobs` + `DELETE FROM epics` + drain, assert byte-identical `epics.job_links` JSON.
- Add a v20→v21 migration backfill test mirroring db.test.ts:2316. Cover orphan-entry retention with defaults.
- Update `test/board.test.ts` fixtures to include the new fields; assert the simplified one-branch render and confirm the `title ?? job_id` fallback.
- Update `test/readiness.test.ts` to drop the `jobs` Map arg from `anyJobLinkRunning` calls; assert the verdict reads off `link.state`.
- Add a test that `EpicSnapshot` does not blank the enriched fields (`job_links` carve-out survives the widened shape).

## Acceptance

- [ ] `JobLinkEntry` carries `{kind, job_id, title, state, rate_limited_at}`
- [ ] Shared `enrichJobLink` helper in `src/reducer.ts`; used by `syncPlanctlLinks`, `syncJobLinksOnJobWrite`, and the migration backfill
- [ ] `syncJobLinksOnJobWrite(db, jobId)` in `src/reducer.ts`; wired at every reducer call site that currently calls `syncIfPlanRef`; short-circuits when `epic_links === '[]'`
- [ ] Missing `jobs` row at enrichment → defaults `(title: null, state: "stopped", rate_limited_at: null)`; no throw inside the fold transaction
- [ ] `SCHEMA_VERSION = 21`; v20→v21 backfill re-derives every epic's `job_links` using the shared enrichment helper; orphan entries retained with defaults
- [ ] `src/readiness.ts` `anyJobLinkRunning(epic)` (no `jobs` arg); both callers updated
- [ ] `scripts/board.ts` `renderJobLinkLines(jobLinks)` (no `jobsById` arg); single render branch; HELP and JSDoc updated
- [ ] CLAUDE.md, README.md, `src/types.ts` JSDoc, `scripts/board.ts` HELP/JSDoc all updated
- [ ] `bun test` passes on every touched test file
- [ ] Re-fold determinism test passes (byte-identical `epics.job_links` after rewind + DELETE + drain)

## Done summary

## Evidence
