## Description

**Size:** M
**Files:** src/reducer.ts, test/reducer-links.test.ts, test/reducer-projections.test.ts

### Approach

Add `loadAllCommitTrailerFacts(db)`: one pass over `SELECT events.id, COALESCE(events.data, event_blobs.data) AS data FROM events LEFT JOIN event_blobs ON event_blobs.event_id = events.id WHERE hook_event = 'Commit' ORDER BY events.id ASC`, parsing each row in JS via the existing `extractCommit` (returns null on malformed — never throws) and re-asserting `planctl_op`/`planctl_target` non-null, exactly as `loadCommitTrailerInvocations` does today (src/reducer.ts:4883-4900). No SQL `json_extract` remains in the commit-trailer channel — this removes the malformed-JSON throw surface from the fold entirely (the never-throw-inside-a-fold invariant; the old WHERE-clause `json_extract` could throw before `extractCommit`'s try/catch ever ran).

Group the flat list once per `syncPlanctlLinks` call: `factsBySession: Map<committer_session_id, ClassifierInvocation[]>` (insertion order = events.id ASC, preserving today's ORDER BY concat semantics) and an epic-membership lookup serving `loadCommitTrailerSessionsForEpics`'s predicate unchanged (`parsePlanRef(target)?.epic_id ∈ epicIds OR raw target ∈ epicIds`, src/reducer.ts:4948-4952). Swept-session lookups use `factsBySession.get(sid) ?? []` so commit-only sessions (zero scrape-side rows) still surface; the `sessionIds.add(sessionId)` self-inclusion (src/reducer.ts:5074) is untouched. Place the single load AFTER the `touchedEpics.size === 0` early return (src/reducer.ts:5045) so no-epic folds pay nothing — but note the CURRENT session's own trailer facts (src/reducer.ts:5001) are needed before that gate; load once at that point and reuse for the sweep. The two old loaders become thin wrappers or are deleted (single caller each).

Semantic equivalence is the whole task: same session sets, same per-session fact order, same classifier dedup input order as the ~40-scan baseline. The UNION-vs-OR identity precedent at src/reducer.ts:5052 is the standing example of this discipline.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:4863-4957 — both loaders being replaced; the exact re-assert and predicate semantics to preserve
- src/reducer.ts:4959-5127 — syncPlanctlLinks call sites: current-session load (:5001), session sweep (:5057-5081), per-session loop (:5085-5127)
- src/reducer.ts:2331-2336 — foldCommit trigger (third caller context; committer_session_id comes from the payload, NOT event.session_id)
- test/reducer-links.test.ts:1358 — commitTrailerEvent helper; existing commit-trailer tests from :1342

**Optional** (reference as needed):
- src/derivers.ts:1127 — extractCommit (the sole Commit-payload parser; try/catch inside)
- test/reducer-projections.test.ts:1041 — re-fold byte-identity test shape to copy

### Risks

- Classifier ts-tie dedup could be insertion-order-sensitive — preserving events.id ASC order within each session group is load-bearing, not cosmetic.
- A commit-only current session (no scrape rows) must still contribute its own creator edge — cover explicitly in tests.

### Test notes

Byte-identity test: seed a mix of scrape-side planctl events, trailer-carrying Commits (inline AND relocated-to-event_blobs payloads), a commit-only session, and one malformed Commit blob; drainAll; snapshot jobs.epic_links + epics.job_links; rewind cursor + wipe projections; drainAll; expect identical. Malformed-blob case asserts no throw and no facts. Fast tier covers reducer shards; run `bun run test:full` before landing.

## Acceptance

- [ ] Exactly one commit-trailer load executes per syncPlanctlLinks invocation (was ~2 + sessions)
- [ ] No SQL json_extract remains in the commit-trailer channel; malformed Commit data folds to no-facts without throwing (test proves it)
- [ ] Re-fold byte-identity test over the trailer-rich seed passes
- [ ] bun run test:full green

## Done summary
syncPlanctlLinks now performs exactly one commit-trailer load per call via loadAllCommitTrailerFacts (grouped by session, reused for current-session facts + cross-session sweep + per-epic rebuild). The SQL json_extract is gone from the commit-trailer channel — every Commit parses in JS via extractCommit, removing the malformed-JSON throw surface; byte-identity preserved.
## Evidence
