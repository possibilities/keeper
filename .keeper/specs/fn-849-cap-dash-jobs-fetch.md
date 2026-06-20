## Overview

Corrective follow-up to the shipped robot job-card dash (epic
`fn-841-robot-job-card-dash`): `keeper dash` shows `0 jobs` while live jobs
exist. The dash subscribes with `jobsFilter: { state: { not_in: [] } }`
(`src/dash/app.ts:685`) to widen to all states, but `JOBS_PAGE_LIMIT = 0` is
UNBOUNDED, so the query returns the entire job history (~3,872 rows) on one
NDJSON line over the 1 MiB `MAX_LINE_LENGTH` (`src/protocol.ts:309`) → the
connection closes before the first snapshot → the dash paints its empty
pre-snapshot state. Fix: cap the dash's jobs fetch at a bounded first page of
50, on the live-only default scope.

## Quick commands

- `bun run cli/keeper.ts dash` — launch on a TTY; the card column now populates with live jobs
- `bun test test/readiness-client.test.ts` — the fast-tier unit test for the new `jobsLimit` option
- `bun run test:full` — mandatory before landing

## Acceptance

- [ ] `keeper dash` shows live job cards again (not `0 jobs`)
- [ ] The jobs fetch is bounded (first page of 50) so it can never exceed the 1 MiB NDJSON line cap, regardless of job-history growth
- [ ] The four other `subscribeReadiness` callers are unaffected (still unbounded)
- [ ] `bun run test:full` green

## Early proof point

The single task `.1` IS the fix. If it fails (e.g. the live-only default scope
doesn't apply once the widen is dropped): fall back to an explicit
`jobsFilter: { state: { not_in: ["ended","killed"] } }` alongside `jobsLimit: 50`.

## References

- Follows `fn-841-robot-job-card-dash` (done) — this corrects its task `.2` dash subscription. No dep edge (a done epic fails the dep resolver); lineage is prose-only.
- Failure mechanism: `src/protocol.ts:309` (`MAX_LINE_LENGTH = 1 MiB`) + `:339` (over-length closes the connection). Decisive repro: live-only subscription → snapshot of 23 jobs; `{state:{not_in:[]}}` → repeated disconnect, no snapshot.
- `src/server-worker.ts:1028-1031` — `not_in: []` contributes no clause (matches all); the filter compiler is NOT the bug — this is a payload-size failure.

## Best practices

- **Use `??` not `||` for the limit default:** `0` is the valid "unbounded" sentinel the four other callers rely on (`?? JOBS_PAGE_LIMIT`). A `||` would coerce a future explicit `0` to the fallback.
- **Page boundary vs display order (known limitation):** the feed pages `created_at DESC`, so a first page of 50 keeps the NEWEST live jobs; on a >50-live-job host an OLD stuck error/awaiting card can fall off. Moot at today's ~23 live jobs; priority-aware paging is deferred.
