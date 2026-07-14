## Description

**Size:** M
**Files:** src/history/model.ts, src/history/catalog.ts, src/history/resolver.ts, src/transcript/model.ts, src/transcript/reader.ts, src/transcript/claude.ts, src/transcript/pi.ts, test/history-catalog.test.ts, test/transcript-cli.test.ts, test/transcript-pi.test.ts

### Approach

Introduce the canonical Harness-session record and Session-reference resolver described by ADR 0062. Build the catalog as the union of approved native Claude/Pi transcript artifacts and supported Keeper jobs, preserving artifact identity, branch/source provenance, zero-to-many job aliases, complete native title records, and honest capability flags.

Resolution is exact and deterministic: qualified native id, exact job id, exact native id, then exact case-insensitive current or historical title. Deduplicate repeated aliases within one catalog entry but preserve copied or duplicate-id artifacts as distinct candidates unless realpath proves they are the same source; never choose by recency.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/transcript/reader.ts:12 — harness-neutral root/list/find/load boundary
- src/transcript/model.ts:1 — normalized metadata and transcript-entry vocabulary
- src/transcript/claude.ts:212 — appended Claude title records and metadata folding
- src/transcript/pi.ts:321 — Pi session tree metadata and appended title records
- src/bus-identity.ts:145 — reusable bound exact/title matching and ambiguity shapes
- cli/show-job.ts:114 — exact historical-title matching with explicit ambiguity

**Optional** (reference as needed):
- docs/adr/0062-unified-session-history-and-resume.md — controlling identity contract
- test/bus-identity.test.ts:1 — existing selector edge-case corpus

### Risks

Native and Keeper identifiers can disagree, copied transcript ids can collide across projects, `jobs.name_history` is capped, and Pi history is tree-shaped. Association needs explicit provenance and conflict results rather than heuristic merging.

### Test notes

Use tiny Claude/Pi JSONL fixtures and a migrated in-memory Keeper DB. Cover standalone native sessions, tracked-only jobs, multiple jobs for one native target, reverted titles, case folding, cross-harness collisions, same-harness duplicate ids, malformed records, and partial unreadable roots.

### Detailed phases

1. Extend normalized metadata to retain title timeline and Pi branch/entry identity without changing title into identity.
2. Add pure catalog assembly and authoritative alias-association rules.
3. Add the Session-reference parser/resolver and structured resolved/not-found/ambiguous/not-tracked outcomes.
4. Route existing transcript discovery through the catalog seam without changing specialist rendering yet.

### Alternatives

Reusing Bus resolution unchanged is rejected because its jobs-only scope and live-preference policy omit standalone sessions and may collapse ambiguity.

### Non-functional targets

Global metadata discovery remains bounded and deterministic, one malformed file cannot abort usable roots, SQL remains parameter-bound, and pure resolver tests require no live daemon, process, or tmux.

### Rollout

This task adds internal seams only. Existing public command behavior remains available until later integration tasks adopt the resolver.

## Acceptance

- [ ] The catalog represents native Claude/Pi artifacts and supported tracked-only jobs with explicit harness, native id, artifact/project, title-history, branch/source, job-alias, and capability provenance.
- [ ] Complete native title records participate as aliases, while current-title selection follows documented native-first/fallback rules and reports reduced coverage for artifact-less jobs.
- [ ] Qualified native ids, exact job ids, exact native ids, and exact current/historical titles resolve through one pure API with structured ambiguity and no recency collapse.
- [ ] Duplicate ids across harnesses or project artifacts remain distinguishable and can be narrowed by harness/project metadata.
- [ ] Standalone sessions resolve for native capabilities and return `not_tracked` only when a requested operation requires Keeper data.
- [ ] Pi branches remain one Harness session with stable branch/entry provenance suitable for search and selected-branch display.
- [ ] Focused catalog and transcript-reader tests pass from explicit test paths.

## Done summary

## Evidence
