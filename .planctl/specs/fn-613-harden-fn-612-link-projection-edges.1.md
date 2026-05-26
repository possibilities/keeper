## Description

Three small touchups landing as one commit, all rooted in the fn-612
widened-job-links work:

- **F1 — `src/reducer.ts:1707-1717` comment misrepresents invariant.**
  The current comment claims the `oldEntry == null` branch is a
  "transient state" that `syncPlanctlLinks` will catch up to. There
  is no async catch-up loop — both projections (`jobs.epic_links` and
  `epics.job_links`) are written atomically by `syncPlanctlLinks` on
  a planctl event, and no other helper de-syncs them (carve-outs
  preserve other entries verbatim, EpicSnapshot ON CONFLICT preserves
  `job_links`, EpicDeleted drops the epic row entirely → shell-insert
  branch). The `oldEntry == null` branch is unreachable in a healthy
  projection. Tighten the comment to say so; keep the `continue` as
  defense-in-depth.

- **F2 — Killed propagation through `syncJobLinksOnJobWrite` is
  untested.** CLAUDE.md ("a `state` flip on UserPromptSubmit / Stop /
  SessionEnd / Killed / RateLimited … propagates to every epic that
  references the session") and the `JobLinkEntry` JSDoc both document
  the invariant; the test suite covers UserPromptSubmit / Stop /
  RateLimited / TranscriptTitle but not Killed. Mirror the existing
  Stop fixture: build an epic + linked session, fire a Killed event
  with matching `(pid, start_time)`, assert `epics.job_links` carries
  `state: "ended"` (or whatever the Killed handler sets) for that
  session.

- **F3 — v20→v21 migration's try/catch at `src/db.ts:1820-1829` is
  untested.** The CLAUDE.md never-throw-inside-migrate invariant is
  load-bearing; a future refactor could remove the guard and wedge
  boot on any DB carrying a corrupt `epics.job_links` blob. Pin it
  with a fixture: open a v20 DB, hand-write a non-JSON string into
  `epics.job_links` for one epic row, close, re-open at v21, assert
  the migration folded the column to `'[]'` and did not throw.

## Acceptance

- [ ] `src/reducer.ts` comment at the `oldEntry == null` branch reframes
      the skip as "unreachable in a healthy projection" (one paragraph;
      names the invariant being defended).
- [ ] `test/reducer.test.ts` adds `syncJobLinksOnJobWrite: Killed state
      flip propagates to epics.job_links` (or equivalent name),
      mirroring the existing Stop fixture.
- [ ] `test/db.test.ts` adds a migration regression that inserts a
      non-JSON string into `epics.job_links` at v20 and asserts the
      v20→v21 migration folds it to `'[]'` without throwing.
- [ ] All existing tests still pass; no behavior change in
      `syncJobLinksOnJobWrite` or the migration itself (comment-only
      change in reducer.ts; tests-only additions otherwise).

## Done summary
Tightened syncJobLinksOnJobWrite oldEntry==null comment (unreachable in healthy projection; continue is defense-in-depth) and pinned two invariants with regression tests: Killed state flip propagates through syncJobLinksOnJobWrite to epics.job_links, and the v20→v21 migration's never-throw guard folds a malformed epics.job_links blob to '[]' without throwing.
## Evidence
