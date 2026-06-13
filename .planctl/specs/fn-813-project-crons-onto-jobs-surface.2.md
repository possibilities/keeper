## Description

**Size:** S
**Files:** src/readiness-client.ts, src/board-render.ts, cli/jobs.ts, test/jobs.test.ts, test/readiness-client.test.ts

### Approach

Wire the `scheduled_tasks` collection through the readiness client and render it in the
expanded job row. Subscription plumbing lives in src/readiness-client.ts, NOT cli/jobs.ts:
a `makeState("scheduled_tasks", …)` block with a page-limit const (:1348-1358 pattern),
entry in the `states[]` array (:1418-1427), entry in `emitSnapshotIfReady`'s gate
(:1429-1456), projection via `projectRows<ScheduledTask>` (:384 — reads `state.rows`,
required so composite-key rows aren't collapsed last-write-wins by `byId`), and a
`scheduledTasks` field on `ReadinessClientSnapshot` (:149-152). An empty collection must
still clear first-paint.

`scheduledTaskLinesFor(index, jobId, indent)` goes in src/board-render.ts beside
`subagentLinesFor` (:660-705) — shared module so board.ts can adopt it later — exported
for tests, reusing `pill()`. Filter `status === 'deleted'` rows out; sort by `ts` asc
with `cron_id` tiebreak. Line shape: `human_schedule` (fall back to `cron`),
recurring/one-shot marker, first line of `prompt_summary` (already truncated by the
fold; treat as untrusted plain text). Client-side wall-clock IS allowed here: mark a
past-due one-shot as spent, and render any cron on an exited/terminal job as expired
(job state is the authority — the projection never flips rows). `durable` is stored
but not rendered.

In cli/jobs.ts: build a per-frame `job_id → ScheduledTask[]` index from
`snap.scheduledTasks` in `renderBody` (:843-863 pattern), and append the lines inside
the `if (isExpanded)` block AFTER the `subagentLinesFor` loop (:489-507; established
order is backend pill → monitors → subagents → scheduled tasks).

### Investigation targets

**Required** (read before coding):
- src/readiness-client.ts:1348-1456, :384, :149-152 — makeState wiring, states[], snapshot gate, projectRows, snapshot interface
- cli/jobs.ts:489-507, :843-863 — expanded block render order + per-frame index pattern
- src/board-render.ts:660-705 — subagentLinesFor: the helper shape, pill() reuse, export-for-tests convention

**Optional** (reference as needed):
- cli/jobs.ts:256-301 — monitorLinesFor: []-on-malformed fallback style
- test/jobs.test.ts, test/readiness-client.test.ts — existing render-helper and subscription test shapes

### Risks

- Forgetting the `emitSnapshotIfReady` gate entry (or the `states[]` entry) wedges or skews first paint — the gate and the array must both gain the collection.
- Reading `byId` instead of `state.rows` renders exactly one cron per job; the multi-cron test must pin this.

### Test notes

test/jobs.test.ts: multiple crons per job all render; deleted hidden; spent/expired
marking; ordering stable. test/readiness-client.test.ts: snapshot carries
scheduledTasks; empty collection still flips ready. `bun run test:full` mandatory.

## Acceptance

- [ ] Expanded job row lists the job's active crons after the subagent section: schedule, recurring/one-shot marker, prompt summary
- [ ] Deleted crons hidden; past-due one-shots marked spent; crons on exited jobs render expired — all client-side
- [ ] Multiple crons per job all render (index built from `state.rows`)
- [ ] First paint clears with zero scheduled tasks present
- [ ] `bun run test:full` green

## Done summary
Wired the scheduled_tasks collection through the readiness client and render each job's live crons in the expanded job row after the sub-agent section (schedule, recurring/one-shot marker upgraded to spent/expired on exited sessions, prompt summary), reading state.rows so multi-cron sessions aren't collapsed. Added scheduledTaskLinesFor to board-render, tests in jobs/readiness-client, and README docs for the v68 side table + cron detail section.
## Evidence
