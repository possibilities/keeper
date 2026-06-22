## Description

**Size:** M
**Files:** src/plan-classifier.ts, src/db.ts, keeper/api.py, test/fixtures/plan_classifier_cases.jsonl, test/plan-classifier.test.ts, test/reducer-links.test.ts, test/db.test.ts, test/daemon.test.ts, README.md, CLAUDE.md

### Approach

Add two exclusions to `classifyEntry` (`src/plan-classifier.ts:180-201`): a
`op === "done"` skip and a `op === "close"` skip, both returning `null`,
placed AFTER the `subject_present === false` gate and BEFORE the `epic_id !==
null → refiner` fall-through (L197). Both `deriveEpicLinks` and
`deriveJobLinks` call `classifyEntry` as their single gate, so one edit covers
both axes, and both frozen backfills (v13→v14, v19→v20) delegate to the shared
helper, so they inherit the exclusion with NO parallel edit.

Because existing persisted `jobs.epic_links` / `epics.job_links` already carry
stale worker/closer refiner edges, bump `SCHEMA_VERSION` 79→80 (`src/db.ts:48`)
and add a v79→v80 migration that MIRRORS the v77 ungate block at
`src/db.ts:4028-4045`: inside one `.immediate()` tx, rewind the cursor
(`UPDATE reducer_state SET last_event_id = 0`), `DELETE FROM jobs` + `DELETE
FROM epics` (they carry the link columns + `created_by_closer_of`), call
`rewindLiveProjection(db)` for the live-only git surface (NEVER a bare `DELETE
FROM git_status`), and wipe the same remaining projection set v77 lists
(`subagent_invocations, usage, profiles, dispatch_failures, autopilot_state,
pending_dispatches, dispatch_never_bound, armed_epics, builds`). The full
re-fold happens via the normal post-migrate boot drain — do NOT fold inline in
the migration tx. Add `80` to `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS`
(~L343) in the SAME commit. Match the existing migration comment-block style
(rationale ending in the "MUST add N to SUPPORTED_SCHEMA_VERSIONS" line).

Then re-cut fixtures and update the docstrings/prose (see Test notes + the
epic's Docs gaps).

### Investigation targets

**Required** (read before coding):
- src/plan-classifier.ts:180-201 — `classifyEntry`; exact branch order and the insertion point for the two skips.
- src/plan-classifier.ts:68-76 — `normalizePlanOp`; confirms `close`/`done` pass through unchanged (raw verbs are already `close`/`done`).
- src/db.ts:48 — `SCHEMA_VERSION` (79 → 80).
- src/db.ts:4028-4045 — the v77 ungate migration block; the EXACT wipe list + `rewindLiveProjection` usage to mirror.
- src/db.ts:~1062 — the CLAUDE.md-derived contract comment claiming a link-projection rewind MUST `DELETE FROM commit_trailer_facts`. RECONCILE: repo-scout found v77 does NOT wipe `commit_trailer_facts` (it is a derive INPUT / the fn-695 commit channel, re-read not rebuilt). Read the `commit_trailer_facts` fold to confirm it is idempotent-on-re-fold (keyed by event_id) and match whatever v77 actually does — v77 is the proven precedent for this exact projection set.
- keeper/api.py:343-395 — `SUPPORTED_SCHEMA_VERSIONS` frozenset; append `80`.

**Optional** (reference as needed):
- src/db.ts:2199,2211,2240 (v13→v14) and 2482,2494,2523 (v19→v20) — confirm the backfills delegate to `deriveEpicLinks`/`deriveJobLinks`/`normalizePlanOp` (no logic edit).
- src/reducer.ts:5740-5765 — `created_by_closer_of` independence.
- plugins/plan/src/verbs/epic_close.ts:111 (`verb:"close"`) and plugins/plan/src/verbs/done.ts:194 (`verb:"done"`).
- README.md:2265-2283 (v77 callout template) and :2338-2341 (stale "every op links" prose).

### Risks

- `commit_trailer_facts` wipe decision (above) is load-bearing: wiping it wrongly, or failing to wipe a projection that needs it, breaks byte-identical re-fold or wedges the reducer. Mirror v77 exactly and verify against the real fold.
- A full cursor-0 rewind re-folds the whole deterministic projection set; the expensive O(history) git fold is avoided via `rewindLiveProjection` (skip-floor reset + `seed_required` → boot-seed re-derives it). Confirm the new block does the same, not a bare git-table DELETE.
- `bun run test:full` is mandatory — the fast tier does not cover db/reducer/migration/classifier paths.

### Test notes

- Add fixture cases to `test/fixtures/plan_classifier_cases.jsonl`: a `done` op naming an epic → no edge, and a `close` op naming an epic → no edge, in BOTH `epic_links` and `job_links` modes (there are zero done/close cases today — this is added coverage). Add matching unit assertions in `test/plan-classifier.test.ts`.
- Audit `test/reducer-links.test.ts` for any expectation asserting a `refiner` edge whose backing op is `done` or `close` — drop those edges. The closer-scaffolds-followup case at ~L1994-2046 fires `scaffold`/`create` (not `close`) and asserts `created_by_closer_of` — it MUST stay green.
- Adapt the migration/wipe-version assertions in `test/db.test.ts` and `test/daemon.test.ts` to v80.
- Update docs per the epic's Docs gaps (plan-classifier.ts docstrings, README Architecture + v80 callout, CLAUDE.md migration version); leave `.keeper/specs/*` untouched.

## Acceptance

- [ ] `classifyEntry` returns null for `op === "done"` and `op === "close"` (placed before the refiner branch); `create`/`scaffold`→`creator` and other epic-naming mutations→`refiner` unchanged; no other op normalizes to `done`/`close` (no collateral exclusion).
- [ ] `SCHEMA_VERSION` = 80; the v79→v80 migration mirrors the v77 rewind/wipe block (incl. `rewindLiveProjection`), and the `commit_trailer_facts` treatment matches v77's proven behavior; `80` added to `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` in the same commit.
- [ ] After migration, no `work::`/`close::` session carries a link edge; genuine refiners (`refine-apply`/`next`/`set-*`/deps) still do; `creator` unchanged.
- [ ] `created_by_closer_of` follow-up-lineage signal intact (`test/reducer-links.test.ts:1994` green); a from-scratch re-fold reproduces byte-identical `epic_links`/`job_links`.
- [ ] New `done`/`close` fixture cases added; `test/db.test.ts` + `test/daemon.test.ts` migration assertions updated to v80; `bun run test:full` passes.
- [ ] Docstrings + README + CLAUDE.md updated; `.keeper/specs/*` untouched.

## Done summary
Excluded the worker's done op and closer's close op from the plan-link classifier (classifyEntry returns null before the refiner branch); v79->v80 migration rewinds the cursor + wipes link projections while raising the git skip-floor to preserve the v79 carve-out. Added done/close fixtures + unit tests, bumped api.py + version pins to 80, updated docs.
## Evidence
