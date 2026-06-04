## Description

**Size:** M
**Files:** src/reducer.ts, src/db.ts, keeper/api.py, src/types.ts, test/reducer.test.ts, test/schema-version.test.ts

### Approach

Make the durable commit-trailer facts feed the SAME sole edge writer. Widen
`syncPlanctlLinks` (reducer.ts:5161) per-session invocation source to UNION
(a) today's `events.planctl_op` scrape rows with (b) commit-trailer facts derived
from `Commit` events for that `committer_session_id` (the `planctl_op`/
`planctl_target` frozen in the payload by task `.2`), deduped by `(kind, job_id)`,
classified via the EXISTING `deriveEpicLinks` predicate (no second classifier),
full-replaced through `enrichJobLink` + `sortEpicLinks`/`sortJobLinks`. In
`foldCommit` (reducer.ts:2566), after the discharge + `foldCommitTaskLinks` arms,
when the payload carries a non-null `planctl_op` + epic-shaped `planctl_target` +
`committer_session_id`, TRIGGER `syncPlanctlLinks` for that session (like
`syncIfPlanRef`) — do NOT write the edge cells directly (single-writer
invariant). Schema bump v53→v54: whitelist-only (the union rides free in the
existing `job_links`/`epic_links` JSON-TEXT cells, no new column) — comment-only
migrate slot mirroring v48→v49 (db.ts:5011), add 54 to `keeper/api.py`
`SUPPORTED_SCHEMA_VERSIONS` (:190) in the SAME change. Re-fold determinism: both
inputs are immutable events; pre-feature `Commit` events have NULL `planctl_op`
→ union no-op → byte-identical historical re-fold.

### Investigation targets

**Required:**
- src/reducer.ts:5161 `syncPlanctlLinks` (widen invocation source to the union; keep full-replace), :5219 the from-scratch replace, :5240 orphan-skip, :5341 shell-insert-missing-epic
- src/reducer.ts:2566 `foldCommit` + :2724 `foldCommitTaskLinks` call (where to add the `syncPlanctlLinks` trigger)
- src/reducer.ts:4745 `enrichJobLink`, :4679 `sortEpicLinks`, :4700 `sortJobLinks` (reuse verbatim)
- src/plan-classifier.ts:242 `deriveEpicLinks` / :300-309 the creator/refiner rule (the single classifier the union must use)
- src/db.ts:61 `SCHEMA_VERSION`, :5011 the v48→v49 whitelist-bump template; keeper/api.py:190 `SUPPORTED_SCHEMA_VERSIONS`

**Optional:**
- src/reducer.ts:4832 `syncJobLinksOnJobWrite` (confirm a commit-minted `epic_links` still triggers the reverse title/state re-stamp)

### Risks

- `syncPlanctlLinks` is keyed per-session; the commit fact's `committer_session_id` must key into the SAME per-session rebuild — verify a commit by session X rebuilds X's `epic_links` from BOTH sources, not a partial.
- `test/schema-version.test.ts` fails the build if 54 isn't added to `keeper/api.py` in this same change.
- Commit-before-claim (a creator edge keyed on the epic vs a missing jobs row): reuse `syncPlanctlLinks`'s existing orphan-skip / shell-insert-missing-epic semantics, don't invent new behavior.

### Test notes

test/reducer.test.ts: union dedup (scrape + commit for the same `(epic, kind, job)` → one edge), commit-only path (scrape NULL but trailer present → edge appears — the fix-forward fn-635-class fixture), pre-feature no-op, and a from-scratch re-fold byte-identical test (pattern at :3863) over a log containing pre-feature `Commit` events. The schema-version test auto-covers the api.py add.

## Acceptance

- [ ] `syncPlanctlLinks` emits edges from the UNION of scrape events + commit-trailer facts, deduped by `(kind, job_id)`
- [ ] a scaffold whose stdout scrape yielded NULL `planctl_op` still produces a creator edge via the commit trailer (fix-forward proof)
- [ ] `foldCommit` TRIGGERS (never directly writes) the edge rebuild; single-writer preserved
- [ ] `SCHEMA_VERSION = 54` + `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` includes 54; schema-version test green
- [ ] from-scratch re-fold reproduces byte-identical `job_links`/`epic_links` over a log containing pre-feature `Commit` events

## Done summary

## Evidence
