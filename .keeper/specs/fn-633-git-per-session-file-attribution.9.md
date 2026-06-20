## Description

**Size:** S
**Files:** README.md, CLAUDE.md (AGENTS.md is symlinked, no separate edit)

### Approach

Six README sections to revise per docs-gap-scout's findings, plus three CLAUDE.md invariant-block updates. Lands last in the epic chain so prose describes the final landed shape, not a moving target.

**README.md updates:**

1. **"What keeper is" paragraph (lines 97–99)**: rewrite the `git` collection description for the file-centric shape — drop "per-live-job dirty/planctl groupings" framing, describe per-file attribution arrays with sources (tool/bash/inferred), commit discharge.
2. **"Example clients" git.ts entry (lines 436–455)**: collapse the old description, describe the new attribution-list rendering with source badges and multi-attribution.
3. **Architecture sparse-columns count (line 503)**: increment count + extend list with `bash_mutation_kind`, `bash_mutation_targets`.
4. **Architecture schema-version chronicle (lines 563–597)**: add v31 clause — events widening + jobs rename/add + file_attributions table + producer-stat embedded mtimes + commit discharge rule.
5. **Readiness client description (lines 677–686)**: confirm whether existing prose references `git_orphan_count` by name; update to `git_unattributed_to_live_count` if so.
6. **Inspect section (lines 694–749)**: add a `git_status` query example showing the new dirty_files JSON shape and a `file_attributions` query example showing the per-(session, file) breakdown.

**CLAUDE.md updates:**

1. **Sparse-columns enumeration** (current "eight sparse top-level signals" passage): increment count + add `bash_mutation_kind` and `bash_mutation_targets` to the list.
2. **DO-NOT list synthetic events by name**: add `Commit` alongside `TranscriptTitle`, `EpicSnapshot`, `TaskSnapshot`, `Killed`, `GitSnapshot`, `GitRootDropped`, `UsageSnapshot`, etc.
3. **Schema-version pair-step note** (currently references v27–v28 for `git_dirty_count`/`git_orphan_count`): update to reflect v31's rename + add (renamed `git_orphan_count` → `git_unattributed_to_live_count`, new strict `git_orphan_count`, new `file_attributions` table maintained inside BEGIN IMMEDIATE).
4. **Worker contract block**: confirm git-worker description (if explicit) covers the new Commit-event emission + file-centric snapshot payload.

AGENTS.md is a symlink to CLAUDE.md per the existing convention — never `rm`+recreate.

### Investigation targets

**Required:**
- README.md (full file read — it's 800 lines, but only sections at lines 97-99, 436-455, 503, 563-597, 677-686, 694-749 need touching)
- CLAUDE.md (full file read — invariant blocks for sparse columns, DO-NOT list, schema-version pair-step note)
- docs-gap-scout pinned report (in this conversation history) for exact section-line refs

### Risks

- README schema chronicle gets long over time; v31 clause should be present-tense ("as of schema v31, jobs gains git_unattributed_to_live_count (renamed from former git_orphan_count) + the new strict git_orphan_count; events gains bash_mutation_kind + bash_mutation_targets; file_attributions is a new projection table") not historical.
- CLAUDE.md's "eight sparse top-level signals" enumeration: be precise about the new count and list ordering — agents read this and grep for column names.
- AGENTS.md symlink: do NOT `rm` + recreate; edit CLAUDE.md in place.

### Test notes

Manual proofread post-edit. No automated test surface for prose. Run `bun test` to confirm no regressions in code (this task touches only Markdown).

## Acceptance

- [ ] README.md sections at lines 97-99, 436-455, 503, 563-597 updated for v31 shape
- [ ] README.md Inspect section gains `git_status` + `file_attributions` query examples
- [ ] CLAUDE.md sparse-columns enumeration count + list updated to include `bash_mutation_kind`, `bash_mutation_targets`
- [ ] CLAUDE.md DO-NOT list synthetic events includes `Commit`
- [ ] CLAUDE.md schema-version pair-step note describes v31 rename/add/table-add accurately
- [ ] AGENTS.md symlink intact (not modified directly)
- [ ] Manual proofread + `bun test` passes

## Done summary
Updated README + CLAUDE.md prose for schema v31: file-centric git surface, per-(session, file) attribution with commit-discharge semantics, sparse-columns count bumped 8→10, Commit synthetic event added to DO-NOT enumeration, Inspect section gains git_status + file_attributions queries.
## Evidence
