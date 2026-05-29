## Description

**Size:** M
**Files:** src/readiness.ts, scripts/board.ts, src/readiness-client.ts, scripts/autopilot.ts, test/readiness.test.ts, test/board.test.ts, test/readiness-client.test.ts, CLAUDE.md, README.md

### Approach

Switch the readers to the projection and delete the stopgap.

Predicate 9 (readiness.ts:524-597) reads B's projected `resolved_epic_deps`
tri-state instead of calling `resolveEpicDep` live: `satisfied` skips,
`blocked-incomplete` becomes a `dep-on-epic` BlockReason (carry
`resolved_epic_id` + `cross_project` so the reason matches today byte-for-byte),
`dangling` becomes `dep-on-epic-dangling`. The board summary pill
(board.ts:778-799) reads the same projected entries instead of resolving.
Confirm autopilot's `reason.kind` string consumption (autopilot.ts ~537-551) is
unchanged.

Delete the fn-637 stopgap: the `completedEpics` subscription, snapshot field,
`computeReadiness` `completedEpics` param + its merge into the resolver index,
and the board merge. Revert the readiness-client first-paint gate + every
initial-query-count test from 5 back to 4 (undo the churn from commit 875d3bd).
If `computeReadiness` no longer resolves deps, drop the now-dead
epicById/epicsByNumber assembly there — but VERIFY no other predicate still
needs those indexes before removing.

Docs: update CLAUDE.md (+AGENTS.md symlink) — add the reverse-dep fan-out to the
cursor+projection invariant enumeration, bump the schema-version note, extend
the EpicSnapshot ON CONFLICT carve-out list with `resolved_epic_deps`, and PRUNE
the fn-637 stopgap references. Update README `## Architecture` with the new
column + `epic_dep_edges` + fan-out paragraph and revise the stopgap
description.

fn-636 has already landed (done+approved); its assertions against
board.ts:785-799 are already in the tree — rebase them onto the projection-backed
surface as part of this cutover (no sequencing dep needed).

### Investigation targets

**Required**:
- src/readiness.ts:524-597 — predicate 9 consumer loop (the read site)
- src/readiness-client.ts:139, :997, :1007-1018, :1070-1096, :1182-1194 — the stopgap surface to delete
- scripts/board.ts:778-799, :884-904 — the resolve call + the fn-637 merge
- scripts/autopilot.ts ~:537-551 — `reason.kind` string surface (must stay intact)
- test/readiness-client.test.ts — the 5 to 4 count reversions (initial query counts, first-paint gate, slow-flight, reconnect)
- CLAUDE.md cursor+projection invariant block + ON CONFLICT carve-out enumeration; README.md `## Architecture` "As of schema vN" log

**Optional**:
- src/readiness.ts:278-327 — `completedEpics` merge into the resolver index (delete)

### Risks

- Behavior parity: the projected tri-state must reproduce predicate 9's current four outcomes exactly (the conversation established `completed = status=done && approval=approved`, a raw fact, so the amber case needs no live close-verdict).
- `computeReadiness` may still need the resolver indexes for another predicate — verify before deleting.

### Test notes

- Predicate 9 tests rebased to drive off `resolved_epic_deps`; assert the same BlockReason shapes (incl. `cross_project`).
- readiness-client first-paint + query-count tests back to 4 collections.
- Board pill tests read the projection.
- Full suite green (minus the pre-existing live-shell ANSI failures).

## Acceptance

- [ ] Predicate 9 and the board pill read `resolved_epic_deps`; no live `resolveEpicDep` call on the read path; `BlockReason` (incl. `cross_project`) preserved for autopilot.
- [ ] fn-637 stopgap fully deleted (subscription, snapshot field, param, both merges); readiness-client gate + counts reverted to 4.
- [ ] CLAUDE.md/AGENTS.md + README updated (4th fan-out, schema bump, carve-out, fn-637 refs pruned).
- [ ] Full affected-suite green; behavior matches the pre-cutover board/autopilot output.

## Done summary
Predicate 9 + board pill cut over to read epic.resolved_epic_deps off the schema-v34 projection; fn-637 stopgap (completedEpics subscription + merges) deleted, readiness-client back to 4 collections. BlockReason payloads (dep-on-epic with cross_project, dep-on-epic-dangling) byte-preserved for autopilot. Docs (CLAUDE.md + README) document the syncResolvedEpicDeps forward/reverse fan-out and prune fn-637 references.
## Evidence
