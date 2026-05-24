## Description

**Size:** S
**Files:** src/collections.ts, src/types.ts, src/derivers.ts, README.md, CLAUDE.md, scripts/jobs.ts, scripts/epics.ts

### Approach

Round-trip the new columns through every documented surface.

`src/collections.ts`:
- `JOBS_DESCRIPTOR` (line ~101): add `"epic_links"` to `columns` AND `jsonColumns` (so the UDS read boundary auto-decodes it).
- `EPICS_DESCRIPTOR` (lines ~158-218): same for `"job_links"`.

`src/types.ts`:
- `Event` interface: add five sparse fields with TSDoc mirroring the existing `slash_command` / `skill_name` style (gating condition, which deriver populates, partial-index predicate, NULL-on-other-events guarantee).
- `Job` interface: add `epic_links: EpicLink[] | null` (or whatever the analog of `EmbeddedJob` is for links). Revise the existing `plan_verb` / `plan_ref` TSDoc to clarify coexistence: spawn-name pair = job's own planctl spawn role; `epic_links` = invocation-classifier cross-references derived from observed planctl-CLI footprint.
- `Epic` interface: add `job_links: JobLink[]` (symmetric).
- Define `EpicLink` / `JobLink` types with `kind: "creator" | "refiner"` and the appropriate target/job_id field.

`src/derivers.ts`:
- Update the module-level JSDoc to enumerate four derivers (was three). Reword the introductory list to add `extractPlanctlInvocation` with a one-line description mirroring the existing entries.
- Add full TSDoc for `extractPlanctlInvocation` (already done in task .1 if planner included it; otherwise add here).

`README.md`:
- Sparse-column callout: currently says "two sparse signals" (`slash_command`, `skill_name`); revise to enumerate the five new `planctl_*` columns alongside. Consolidate into one paragraph; do not append a second.
- Architecture section's plan-producer paragraph: add the invocation-classifier fan-out path (`planctl_op != NULL` event → `syncPlanctlLinks` → `jobs.epic_links` + `epics.job_links`) alongside the existing `syncJobIntoEpic` spawn-name path. Both fan-outs are described as in-transaction, re-fold deterministic.
- Inspect section sample queries: add representative queries for the new columns (`WHERE planctl_op IS NOT NULL`) and projections (`json_array_length(epic_links) > 0`, `json_array_length(job_links) > 0`).

`CLAUDE.md`:
- Event-sourcing invariants — projection-driving facts bullet: add `extractPlanctlInvocation` and the five `planctl_*` derived columns alongside the existing entries. Add `syncPlanctlLinks` to the canonical synthetic-fan-out list at parity with `syncJobIntoEpic`.
- Re-verify "no third-party deps in the hook" stays accurate (the hook imports `src/derivers.ts` only — NOT `src/plan-classifier.ts`).

`scripts/jobs.ts` / `scripts/epics.ts` (optional but encouraged):
- At minimum, the module-level comment documents the new projection field exists on the row.
- Optionally render the new field as an additional column with a sane truncation rule.

### Investigation targets

**Required** (read before coding):
- `src/collections.ts:87-134` — `JOBS_DESCRIPTOR` shape (columns + jsonColumns).
- `src/collections.ts:158-218` — `EPICS_DESCRIPTOR` shape.
- `src/types.ts:93-133` — `Job` interface and `EmbeddedJob` precedent.
- `src/types.ts:192-225` — `Epic` interface.
- `src/types.ts` (Event interface) — TSDoc patterns on `slash_command` / `skill_name`.
- `src/derivers.ts:1-37` — module-level JSDoc (the enumeration to update).
- `README.md` (sparse-column callout — search for "two sparse signals").
- `CLAUDE.md` event-sourcing invariants section.

**Optional**:
- `scripts/jobs.ts` (whole file) — rendering pattern.
- `scripts/epics.ts` (whole file) — rendering pattern.

### Risks

- Doc drift: the docs-gap-scout flagged that revising rather than appending is the right move (one paragraph per concept, not a growing list). Mitigation: rewrite enumerations and counts in place rather than tacking on second paragraphs.
- `EmbeddedJob` shape divergence: confirm whether `epic_links` is embedded inside an epic's per-task `jobs` array (i.e. the embedded shape also gains `epic_links`) or only on the top-level `jobs` collection. Per the gap-analyst's edge case note, this is a design decision worth resolving in code review — default to "top-level only, embedded jobs do NOT carry epic_links" for simplicity unless the embedded shape is the canonical render surface.

### Test notes

- One collections-roundtrip test (or extend an existing one) asserts that a `jobs` collection page carries `epic_links` as a decoded array, and an `epics` page carries `job_links`.
- Doc updates verified by spot-reading the rendered README + CLAUDE.md sections.

## Acceptance

- [ ] `JOBS_DESCRIPTOR` and `EPICS_DESCRIPTOR` carry the new columns + jsonColumns entries.
- [ ] `Job.epic_links`, `Epic.job_links`, and the five sparse `Event.planctl_*` fields are typed with TSDoc matching the existing style.
- [ ] `src/derivers.ts` module JSDoc enumerates four derivers.
- [ ] `README.md` sparse-column callout, Architecture paragraph, and Inspect queries reflect the new columns/projections.
- [ ] `CLAUDE.md` projection-driving-facts list mentions the new deriver + columns + fan-out at parity with `slash_command` / `skill_name`.
- [ ] `planctl validate --epic <epic_id>` passes end-to-end after this task lands.

## Done summary
Round-tripped epic_links + job_links columns through README sparse-signal callout/Architecture/Inspect sections, CLAUDE.md invariants (cursor-transaction + projection-driving-facts), scripts/{jobs,epics}.ts module comments, and added two collections-roundtrip tests via a new seedJob helper + seedEpic.job_links opt; all 301 unit tests pass.
## Evidence
