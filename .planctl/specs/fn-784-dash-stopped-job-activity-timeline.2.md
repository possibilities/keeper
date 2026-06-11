## Description

**Size:** M
**Files:** src/dash/view-model.ts, src/readiness.ts, test/dash-view-model.test.ts, README.md

Rework the dash AGENTS region to show all non-terminal jobs on one unified
`active_since` timeline with per-job rolled-up board icons. Depends on task
`.1` (needs `active_since` on the `Job` type and the wire).

### Approach

**Per-job rollup helper (readiness.ts).** Add ONE exported function that
takes a top-level `Job`, the running-subagent set, and `nowSec`, and returns
the rolled-up `Verdict` (or an idle sentinel). It must reuse the existing
module-private predicates' LOGIC (`anyEmbeddedJobWorking` and the
sub-agent / monitor stale splits, `src/readiness.ts:1296-1430`) and derive
worker-monitor liveness from the job's raw `monitors` JSON the SAME way
`buildEmbeddedJob` does (worker-launched `monitor`/`bash-bg` only, `ambient`
excluded) — extract/share that derivation so the AGENTS glyph cannot drift
from the board pill. Precedence mirrors the board: job-working →
`running:job-running`; else running subagent → `running:sub-agent-running`
(or `:sub-agent-stale` when all are past `SUBAGENT_STALENESS_SEC`); else
live worker monitor → `running:monitor-running` (or `:monitor-stale` past
`MONITOR_STALENESS_SEC`); else idle. Build the running-subagent set from
`snapshot.subagentInvocations` filtered to `status === 'running'` (reuse
readiness's own filter), and use the `nowSec` already passed into
`buildAgents` for the stale split. Read-side must NEVER throw: malformed
`monitors` JSON folds to idle, never an exception mid-frame.

**buildAgents (src/dash/view-model.ts:399-454).**
- Drop the `job.state === "working" || ny` include filter — push EVERY job in `snapshot.jobs` (the collections `defaultFilter` already excludes ended/killed).
- Replace the comparator: remove the needs-you-first branch; sort by `COALESCE(active_since, created_at)` DESC with `job_id` ASC tiebreak. Do this in JS — the wire delivers `active_since` as `number | null`, so the key is `(a.active_since ?? a.created_at)`; guard the null explicitly (do not let a JS `null` coerce to 0).
- Leading glyph: replace the verb-keyed `roleGlyph` with the rollup `Verdict` → `verdictPill`/`glyphOr` glyph, colored via the existing `roleForVerdict` (idle → the `stopped` token → `circleO`, terminal/dim role). Keep `jobLabel`, `elapsedBand`, and the trailing `awaiting`/`failed` needs-you annotation exactly as-is (annotation only, no sort effect).
- Rewrite the `buildAgents` JSDoc (`:391-397`) to describe the new filter, sort key, and rollup glyph.

**Docs (README.md).** Update the `dash.ts` bullet (~line 1015), the
`## Architecture` schema narrative ("As of schema v65…", ~1377-1500), and
the `## Inspect` jobs-query column comment (~2387).

### Investigation targets

**Required** (read before coding):
- src/dash/view-model.ts:325-454 — `needsYou`, `roleGlyph`, `jobLabel`, `elapsedBand`, and `buildAgents` (the function to change) + its JSDoc
- src/dash/view-model.ts:99,237,256 — `glyphOr`, `roleForVerdict`, `verdictPill` (the machinery to reuse; already used for PLAN rows)
- src/readiness.ts:1296-1430 — the private predicates + stale-split constants (`SUBAGENT_STALENESS_SEC`, `MONITOR_STALENESS_SEC`)
- src/reducer.ts (or src/derivers.ts) `buildEmbeddedJob` / monitor-provenance derivation — the worker-vs-ambient monitor filter to share
- src/readiness-client.ts:1451-1530 — snapshot assembly: confirms `snapshot.subagentInvocations` is the uncollapsed flat array and how readiness builds its running map
- src/icon-theme.ts:95-108 — the `running:*`→glyph map + `circleO` (all reused)
- test/dash-view-model.test.ts:73-102,461-479 — `makeJob` factory and the existing sort-test template to rewrite

**Optional** (reference as needed):
- src/types.ts:526 — `EmbeddedJob.has_live_worker_monitor` (the fact to replicate from raw `monitors`)
- src/types.ts:568 — `SubagentInvocation` shape

### Risks

- **Embedded-vs-top-level mismatch (keystone).** The readiness predicates take epic-embedded job arrays + a `subRunningByJobId` map, but `buildAgents` iterates the top-level `Job` Map and `has_live_worker_monitor` is NOT on the top-level `Job`. Resolution: the new helper derives the worker-monitor fact from raw `Job.monitors` JSON via the shared deriver, and builds the running-subagent set from `snapshot.subagentInvocations`. Verify the derived fact matches `buildEmbeddedJob`'s for an epic-embedded job (no divergence).
- **Glyph/pill threshold flicker.** The AGENTS glyph uses frame `nowSec`; the PLAN pill uses the snapshot's frozen `now`. Disagreement is a sub-second window every 2–10 min at a staleness boundary — accepted, not worth plumbing the frozen now.
- **Losing actionable visibility.** Needs-you no longer floats to the top (the settled "pure unified sort"). The `awaiting`/`failed` annotation still renders, so the signal is not lost, only re-positioned.

### Test notes

In `test/dash-view-model.test.ts` (OpenTUI-free fast tier), rewrite the sort
block (`:461-479`) and add:
- Unified `COALESCE(active_since, created_at)` DESC sort including stopped jobs; a stopped job with a more-recent `active_since` outranks a working job with an older one.
- NULL `active_since` falls back to `created_at` (a never-prompted job sorts by creation).
- needs-you does NOT reorder (a needs-you stopped job sorts purely on its `active_since`), but the `awaiting`/`failed` annotation still renders.
- Per-job rollup glyph across the matrix: working→sync, fresh subagent→cogs, stale subagent→warn, live worker monitor→eye, stale monitor→warn, idle→circleO, and ambient-only monitor → idle (not eye).
- A wire row delivers `active_since` as `number | null` (not `undefined`) — guards against the collections-columns omission from task `.1`.

## Acceptance

- [ ] `buildAgents` includes all non-terminal jobs and sorts by `COALESCE(active_since, created_at)` DESC, `job_id` ASC tiebreak, with no needs-you reordering.
- [ ] An exported readiness helper computes the per-job rolled-up verdict uniformly (plan-linked + ad-hoc), reusing the existing predicates and the shared worker-monitor deriver (ambient excluded); read-side never throws on malformed `monitors`.
- [ ] Each AGENTS row renders the rollup glyph (sync/cogs/eye/warn/circleO) via the existing `verdictPill`/`roleForVerdict`; trailing `awaiting`/`failed` annotation unchanged.
- [ ] view-model tests cover the unified sort, NULL fallback, needs-you-no-reorder, and the full glyph matrix incl. ambient-only→idle; `buildAgents` JSDoc rewritten.
- [ ] README `dash.ts` bullet, schema narrative, and `## Inspect` comment updated; `bun run test:full` green.

## Done summary

## Evidence
