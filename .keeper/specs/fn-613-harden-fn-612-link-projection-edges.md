## Overview

Tighten three small edges left by the fn-612 widened-job-links work: a
misleading comment in `syncJobLinksOnJobWrite` that claims an async
catch-up loop exists (it doesn't — the branch is unreachable in any
healthy projection), and two regression-test gaps for documented
invariants (Killed state-flip propagation through `syncJobLinksOnJobWrite`,
and the v20→v21 migration's never-throw guard against a malformed
`epics.job_links` blob).

## Acceptance

- [ ] `src/reducer.ts:1707-1717` comment reframes the `oldEntry == null`
      skip as "unreachable in a healthy projection" rather than
      "transient state that `syncPlanctlLinks` will catch up to" — no
      self-heal code; the branch stays a `continue`.
- [ ] `test/reducer.test.ts` carries a `syncJobLinksOnJobWrite: Killed
      state flip propagates to epics.job_links` test mirroring the
      existing Stop/UserPromptSubmit/RateLimited fixtures.
- [ ] `test/db.test.ts` carries a v20→v21 migration test that inserts a
      non-JSON string into `epics.job_links` before migrate runs and
      asserts the migration folds the column to `'[]'` without throwing
      (pins the never-throw-inside-migrate invariant against future
      refactors that might drop the try/catch at `src/db.ts:1820-1829`).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | `oldEntry == null` branch in `syncJobLinksOnJobWrite` is unreachable in a healthy projection — both link sides are atomically written by `syncPlanctlLinks` and no other helper de-syncs them. Comment misrepresents the invariant; tighten + add a regression test asserting the branch doesn't fire on a healthy projection. |
| F2 | kept | .1 | Killed propagation through `syncJobLinksOnJobWrite` is a documented invariant in CLAUDE.md and the JobLinkEntry JSDoc but has no test fixture; one-screen addition mirroring the existing Stop fixture. |
| F3 | kept | .1 | v20→v21 migration try/catch at `src/db.ts:1820-1829` is load-bearing for the CLAUDE.md never-throw-inside-migrate invariant; a regression fixture pins it. |
| F4 | culled | — | Placeholder `kind: "creator"` in `enrichJobLink` call is documented with a comment explaining the trick — no user impact; leave on next touch. |
| F5 | culled | — | Dead `_jobs` param on `computeReadiness` retained intentionally for surface stability; no defect, comment already explains. |
| F6 | culled | — | v20→v21 migration N×M SELECT explicitly noted as not a real risk at current projection sizes; one-time boot cost only. |
| F7 | culled | — | `renderJobLinkLines` sort-trust on the reducer's `sortJobLinks` invariant is documented; tests pass ordered arrays; no defect today. |

## Out of scope

- The `syncJobLinksOnJobWrite` self-heal option (re-inserting the edge via `epicLink.kind`) — the branch is unreachable; over-engineering it would paper over the invariant rather than pin it.
- Removing the dead `_jobs` param on `computeReadiness` (F5) — defer to a natural readiness.ts touch.
- Migration perf (F6) — not a real risk today; revisit if migration time becomes perceptible.
- Defensive `sortJobLinks` call inside `renderJobLinkLines` (F7) — relies on a documented reducer invariant; the renderer trusts it correctly.
