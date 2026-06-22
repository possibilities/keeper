## Description

**Size:** M
**Files:** src/reducer.ts, src/plan-classifier.ts, test/refold-equivalence.test.ts, test/reducer-links.test.ts, README.md, CLAUDE.md

### Approach

Replace the per-epic full session-sweep in `syncPlanLinks`
(`reducer.ts:5554-5875`) with an idempotent per-session replace-by-key
merge. For each touched epic: read existing `epics.job_links`, drop every
entry where `job_id === sessionId`, splice this session's freshly-derived
slice (`deriveJobLinks` fed a single-session map `{[sessionId]:
thisSessionInvocations}`), re-sort with `sortJobLinks`. Extract a
**job_links-merge-only** shared helper that both `syncPlanLinks` and
`syncJobLinksOnJobWrite` (`reducer.ts:5197-5273`) call — MERGE ONLY, never
the surrounding closer/sort_path/queue_jump/cascade or shell-insert: those
differ per caller (`syncPlanLinks` owns the fresh classifier `kind` +
`insertEpicShellIfNotTombstoned` with closer columns; the sibling re-stamps
the OLD entry's `kind` + a bare shell-insert). Keep
closer/`sort_path`/`queue_jump` derivation + `cascadeSortPath` per
touched-epic exactly as today (functions of the epic's full merged
`job_links` + descendants, not per-session). Stack the cheap wins, each
behind a green `test:full`: (1) single-session commit-facts read via
`idx_commit_trailer_facts_session` on the NORMAL path; (2) enrich only the
spliced session's entries, preserve others verbatim; (3) pre-filter
tombstoned epics (`isEpicTombstoned`) before the derive loop — but KEEP the
`cascadeSortPath` call for tombstoned epics with live descendants. Orphan
fallback: when `jobsRow == null` (deterministic per event-id), retain the
OLD full-sweep for that epic (it needs the wide commit-facts load; there is
no pre-state to diff). Forward-facing docs: update the README `syncPlanLinks`
narrative + the CLAUDE.md time-bomb bullet (add the O(board) axis) — present
tense, no change-history.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:5554-5875 — `syncPlanLinks`, the surgery site (full sweep :5661-5721, per-epic derive :5730, N+1 enrich :5734, closer/cascade :5743-5873, orphan handling :5560-5566/:5641-5647)
- src/reducer.ts:5197-5273 — `syncJobLinksOnJobWrite`, the idempotent drop-and-re-add precedent AND the shared-helper boundary (note the `kind`-ownership + bare-shell-insert differences)
- src/reducer.ts:5139-5180 — `enrichJobLink`, locked-key-order single source of truth; types.ts:88-106 paired-NULL invariant
- src/plan-classifier.ts:320-366 — `deriveJobLinks`; the `(kind, job_id)` `seen` key at :346 is the load-bearing fact (distinct sessions never cross-suppress; intra-session creator-suppresses-refiner stays)
- src/reducer.ts:5475-5552 — `loadAllCommitTrailerFacts` + `commitTrailerInvocationsFor`/`commitTrailerSessionsForEpics`; src/db.ts:1077 `idx_commit_trailer_facts_session`
- src/reducer.ts:486-516 — `isEpicTombstoned` + `insertEpicShellIfNotTombstoned`
- test/refold-equivalence.test.ts — byte-identity gate (`insertEvent`/`drainAll`/`snapshotProjections`/`rewindAndWipeProjections`); the `readSrc()` static-text precedent at :379-482
- test/reducer-links.test.ts:1135, :1079, :1400, :1437, :1481, :1286, :777-844 — correctness tests that MUST stay green

**Optional** (reference as needed):
- src/reducer.ts:5015-5037 — `_syncPlanLinksAccum` perf scaffold (extend, do not duplicate; `sweptSessions` becomes ~1)

### Risks

- **Enrichment-freshness invariant (THE keystone).** Preserving other sessions' entries verbatim is byte-identical to the full re-derive ONLY because every jobs-write that changes `title`/`state`/`last_*` already fans out via `syncJobLinksOnJobWrite`. Encode a static source-text guard asserting every enriched-column jobs-write is paired with `syncIfPlanRef`/`syncJobLinksOnJobWrite`. If the invariant fails, the merge is unsound — verify before relying on it.
- **Removed/changed edge.** Drop ALL of `sessionId`'s entries before splicing (handle `kind` change refiner→creator, count 2→1, 1→0). The →0 case (session no longer touches the epic but it is in pre-state) proves the merge is non-additive — `touchedEpics` must stay `pre ∪ post`.
- **Same-session two-channel union.** The slice input must union this session's scrape invocations AND `commitTrailerInvocationsFor(sessionId)` before deriving, or a commit-only / scrape-only edge is dropped.
- **Tombstone pre-filter** changes which epics get UPDATEd — confirm a tombstoned-but-present epic row is not skipped where the old code UPDATEd it (re-fold divergence); keep the cascade for live descendants.
- Single-session facts read must NOT apply to the orphan path (needs the wide load) — gate it to the normal path.
- Never throw inside the fold; every new parse/read/splice folds to a safe value inside the one `BEGIN IMMEDIATE`.

### Test notes

- Extend test/refold-equivalence.test.ts with fixtures: multi-session epic; removed refiner edge; **orphan (no-jobs-row) session whose edge is removed**; commit-only creator session; tombstoned epic WITH and WITHOUT live descendants; **a jobs-state-change interleaved AFTER a plan edge** (the stale-other-session case that directly exercises the enrichment-freshness invariant). Gate = byte-identical re-fold (`snapshotProjections` before == after `rewindAndWipeProjections` + redrain).
- Add the static source-text guard (the `readSrc` precedent) for the enrichment-freshness invariant.
- Keep every reducer-links.test.ts cross-session / commit-channel / EpicSnapshot test green.
- Optionally add a fast-check property test (random valid event sequence + random split point; assert full-rebuild == incremental deep-equal).
- `bun run test:full` is mandatory.

## Acceptance

- [ ] `syncPlanLinks` no longer sweeps all sessions on the normal (non-orphan) path; per-event cost is independent of how many sessions ever touched the epic
- [ ] the job_links replace-by-key merge is extracted as a shared helper used by both `syncPlanLinks` and `syncJobLinksOnJobWrite` (merge only; closer/sort/cascade/shell-insert stay per-caller)
- [ ] single-session commit-facts read on the normal path; enrichment limited to the spliced session's entries; tombstoned epics pre-filtered before the derive loop (cascade preserved for live descendants)
- [ ] orphan (`jobsRow == null`) sessions retain the full-sweep fallback; the path choice is deterministic per event-id
- [ ] test/refold-equivalence.test.ts extended with the six+ scenarios incl. the stale-other-session case; byte-identical re-fold passes
- [ ] a static source-text guard asserts the enrichment-freshness invariant
- [ ] all existing reducer-links.test.ts correctness tests stay green
- [ ] README `syncPlanLinks`/architecture narrative + CLAUDE.md time-bomb bullet (O(board) axis) updated, forward-facing
- [ ] `bun run test:full` green

## Done summary
Replaced syncPlanLinks's normal-path full session-sweep with an idempotent per-session replace-by-key merge (shared mergeJobLinkSlice helper) so per-event cost is independent of sessions-per-epic and board size; orphan invocations retain the full-sweep fallback. Added seven refold byte-identity fixtures incl. the keystone stale-other-session case plus a static enrichment-freshness source guard.
## Evidence
