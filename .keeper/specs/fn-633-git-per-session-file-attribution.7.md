## Description

**Size:** S
**Files:** src/readiness.ts, src/readiness-client.ts, test/readiness.test.ts

### Approach

Two changes in src/readiness.ts: predicate 6.5 task path (line 327) and close path (line 486) read `git_unattributed_to_live_count` instead of legacy `git_orphan_count`. Block-reason kind name stays `git-orphans` (the reason name is a user-facing label, not the underlying column) — flipping it would ripple into scripts/autopilot.ts:230, :238, :449 and CLAUDE.md reason-kind enumeration without semantic benefit. Document the divergence in readiness.ts comments: "reason kind is `git-orphans` for backward compatibility with autopilot consumers; the underlying signal is the new `git_unattributed_to_live_count` per schema v31."

`src/readiness-client.ts:1039-1058` (`gitStatusByProjectDir` map) projects `git_unattributed_to_live_count` into the per-project map; the existing `orphan_count` field name on the map can stay (it's a client-side projection name, not a column) — keep changes scoped.

**Truly-orphan handling decision**: new strict `git_orphan_count` is INFORMATIONAL ONLY at v31. NOT a new block reason kind, NOT a new predicate. Surfaced in scripts/git.ts (task 8) for human inspection. The rationale: adding a new block reason ripples through autopilot's reason enumeration and the existing predicate 6.5's block semantic. v31 keeps the block surface unchanged; if truly-orphan needs to block, that's a separate refinement epic.

### Investigation targets

**Required:**
- src/readiness.ts:327-359 — predicate 6.5 task path (branches on `gs.dirty_count` and `gs.orphan_count`)
- src/readiness.ts:486-510 — predicate 6.5 close-row path (same branches)
- src/readiness-client.ts:1039-1058 — `gitStatusByProjectDir` row projection
- src/readiness.ts:911-914 — reason-kind enumeration (`git-uncommitted`, `git-orphans`)
- scripts/autopilot.ts:230, :238, :449 — reason-kind consumers (read but DO NOT change here — task 8's job)
- test/readiness.test.ts (existing predicate 6.5 tests; update for new column name)

### Risks

- The reason kind staying `git-orphans` while the column underneath is `git_unattributed_to_live_count` is mildly confusing for future readers. Mitigation: comment block in readiness.ts explaining the divergence + a CLAUDE.md update (task 9) noting the rename.
- Test fixtures: any existing test that hand-crafts a `git_status` row with `orphan_count = N` must update to `git_unattributed_to_live_count = N`. Grep for fixture sites and update.

### Test notes

test/readiness.test.ts: existing predicate 6.5 cases get column-name updates. Add one new case: with `git_orphan_count > 0` AND `git_unattributed_to_live_count == 0`, predicate 6.5 does NOT block (truly-orphan is informational only).

## Acceptance

- [ ] src/readiness.ts:327, :486 read `git_unattributed_to_live_count` instead of `git_orphan_count`
- [ ] Block-reason kind stays `git-orphans` (no autopilot ripple)
- [ ] src/readiness-client.ts:1039-1058 projects the renamed column
- [ ] Existing predicate 6.5 tests pass with column renames
- [ ] New test: `git_orphan_count > 0 && git_unattributed_to_live_count == 0` does NOT block predicate 6.5
- [ ] Comment block in readiness.ts documents the reason-kind-vs-column divergence

## Done summary
Renamed readiness map field from orphan_count to unattributed_to_live_count (schema-v31 column rename). Predicate 6.5 task + close arms now read the renamed value; block-reason kind stays git-orphans for autopilot backward compatibility. Client-side projection computes unattributed_to_live_count from git_status.dirty_files[].attributions[] (counting files with no live working/stopped attribution); the wire column orphaned_count carrying strict-mystery is informational only at v31. Added two acceptance tests proving strict-mystery > 0 with unattributed_to_live == 0 does NOT block; updated existing fn-620/fn-626 predicate 6.5 tests + autopilot.test.ts for the field rename. Column-name-vs-reason-kind divergence documented in readiness.ts BlockReason doc, map-type doc, and both predicate arms.
## Evidence
