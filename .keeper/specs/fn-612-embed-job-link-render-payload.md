## Overview

The board renders epic→creator/refiner lines by joining each
`link.job_id` against the live `snap.jobs` page. Terminal sessions
and off-page live sessions miss the join and fall through to a
degraded `[{job_id}] [{kind}]` line. Per the CLAUDE.md design stance
("project everything the UI needs into the projection"), widen each
`epics.job_links` entry to embed the linked job's `title`, `state`,
and `rate_limited_at` so the renderer — and `anyJobLinkRunning` in
readiness — read everything off the projection with no live-jobs
join.

## Quick commands

- `bun test test/reducer.test.ts test/db.test.ts test/board.test.ts test/readiness.test.ts`
- `bun run scripts/board.ts` — visual smoke; creator/refiner lines render `{title} [creator|refiner] [state]` for every session, in-page or terminal

## Acceptance

- [ ] `JobLinkEntry` widened to `{kind, job_id, title, state, rate_limited_at}`
- [ ] `syncPlanctlLinks` enrichment join reads `(title, state, rate_limited_at)` off the live `jobs` row inside its open transaction
- [ ] New jobs-write fan-out helper re-stamps `epics.job_links` for every epic referenced via the symmetric `jobs.epic_links` array; fires on every jobs-write where `epic_links !== '[]'`; runs inside the same `BEGIN IMMEDIATE`
- [ ] Missing `jobs` row at enrichment time → defaults `(title: null, state: "stopped", rate_limited_at: null)`; never throws
- [ ] Schema bump v20→v21 with a version-guarded re-derive of `epics.job_links` using the SAME enrichment helper as the live reducer (byte-identical re-fold)
- [ ] `scripts/board.ts` `renderJobLinkLines` drops the `jobsById` parameter; two-branch in-page/off-page collapses to one branch
- [ ] `src/readiness.ts` `anyJobLinkRunning` reads `link.state`; `jobs` Map arg removed from signature and both call sites
- [ ] CLAUDE.md, README.md, `src/types.ts` JSDoc, `scripts/board.ts` HELP+JSDoc updated to describe the embedded shape and new fan-out trigger
- [ ] Re-fold determinism test: rewind + `DELETE FROM jobs` + `DELETE FROM epics` + drain reproduces byte-identical `epics.job_links` JSON

## Early proof point

Task that proves the approach: `<epic_id>.1`. If it fails: revert is
a one-commit unwind — the projection shape lives in one column, the
fan-out trigger lives in one helper at known call sites, and the
consumer changes (board, readiness) sit behind the widened shape.

## References

- `fn-611` (overlap) — both epics edit `scripts/board.ts`; fn-611.3 restructures the renderer's emit seam while this epic drops the `jobsById` join. Hard-wired as an epic dep upstream to serialize the edits.

## Docs gaps

- **CLAUDE.md** — extend the `syncPlanctlLinks` invariant bullet: a jobs-write whose `job_id` appears in any epic's `job_links` also re-stamps that epic's `job_links` in the same `BEGIN IMMEDIATE`.
- **README.md** — append a schema-vN sentence noting that each `job_links` entry embeds `title`/`state`/`rate_limited_at` from the linked job's last-known state.
- **src/types.ts** — rewrite the `JobLinkEntry` JSDoc; re-evaluate the "mirrors `JobLink` field-for-field" line (classifier output stays thin).
- **scripts/board.ts** — rewrite the HELP creator/refiner-line grammar; drop the off-page-fallback sentence; update `renderJobLinkLines` JSDoc to name all five fields.

## Best practices

- **Read the source row AFTER you write it, then fan out** — mirrors the existing `syncIfPlanRef` + `syncJobIntoEpic` pattern; reverse fan-out reads its enrichment fields from the post-write `jobs` row inside the same transaction.
- **Use the symmetric `jobs.epic_links` array as the reverse lookup** — single-row PK SELECT + small JSON parse. Do NOT scan `epics.job_links` with `json_each`; it's an unindexed TVF (full scan + virtual-row expansion).
- **Share one enrichment helper between the live reducer fan-out and the migration backfill** — different code paths producing the same JSON is how re-fold determinism breaks silently.
- **Never throw inside `BEGIN IMMEDIATE`** — missing-jobs-row at enrichment time folds to the defaults above; rolling back the cursor wedges the reducer.
- **Do NOT widen `deriveJobLinks` in `src/plan-classifier.ts`** — classifier stays a pure function of events; denormalized fields belong at the reducer's write boundary.
