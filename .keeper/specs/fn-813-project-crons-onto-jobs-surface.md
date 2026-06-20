## Overview

Claude Code sessions arm crons via the CronCreate tool; today those scheduled tasks are
invisible in keeper. This epic projects them onto the job surface: a fold-maintained
`scheduled_tasks` side table keyed `(job_id, cron_id)` built from CronCreate/CronDelete
PostToolUse events, served over the existing collection-subscription wire, and rendered
as a detail section in the expanded job row of the jobs TUI. End state: expand a job,
see its live crons (schedule, recurring/one-shot, prompt summary).

## Quick commands

- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT job_id, cron_id, human_schedule, recurring, status FROM scheduled_tasks ORDER BY ts DESC LIMIT 10"` — projection landed
- `keeper jobs` then expand a job that armed a cron — detail lines render after the subagent section
- `bun run test:full` — mandatory tier for db/reducer/TUI paths

## Acceptance

- [ ] CronCreate/CronDelete events fold deterministically into `scheduled_tasks` (schema v68); a from-scratch re-fold reproduces identical rows
- [ ] Expanded job row in the jobs TUI shows the job's active crons; deleted crons hidden; one-shot past-due and exited-job crons visibly marked client-side
- [ ] `bun run test:full` green, including `test/schema-version.test.ts` (api.py whitelist bumped in the same commit as SCHEMA_VERSION)

## Early proof point

Task that proves the approach: ordinal 1 (the fold + collection). It exercises the full
payload→row pipeline against real event shapes. If it fails: re-derive the payload contract
from live `keeper.db` CronCreate/CronDelete rows (`json_extract` on `COALESCE(events.data,
event_blobs.data)`) and adjust the column set — the TUI task is insulated behind the
collection contract.

## References

- Verified payload shapes (live keeper.db): CronCreate PostToolUse carries `tool_input.{cron,prompt}` + `tool_response.{id,humanSchedule,recurring,durable}`; CronDelete carries `tool_input.id` / `tool_response.id`. Create-side and delete-side ids are the same namespace (session `3eaf6ebb` created and deleted cron `91860814`).
- Resolved semantics: unmatched CronDelete is a no-op; CronCreate upsert resurrects (`status='active'`); fold gates strictly on `hook_event='PostToolUse'` (PostToolUseFailure never mints rows); `durable` stored, not rendered; crons sort by `ts` asc, `cron_id` tiebreak.
- Model code: `projectSubagentInvocationsRow` (src/reducer.ts:3816-3936), dispatch sites src/reducer.ts:6852-6872, descriptor src/collections.ts:344-367, subscription wiring src/readiness-client.ts:1348-1456, render helper src/board-render.ts:660-705.
- ScheduleWakeup is explicitly out of scope (high-churn, consumed-on-fire).

## Docs gaps

- **README.md:131**: update collection inventory — "Seven collections register today" becomes eight; add `scheduled_tasks` in the existing `schema vN (fn-NNN)` cadence
- **README.md:765-821**: document the new scheduled-tasks detail section in the jobs.ts expanded-row docs, same placement convention as Monitors ("sits BETWEEN X and Y")
- **README.md Architecture**: add an "As of schema v68 (fn-NNN), the `scheduled_tasks` side table…" paragraph (v67 entry near line 1830 is the style; present tense, no change narrative)

## Best practices

- **UPSERT, never REPLACE/IGNORE:** `INSERT ... ON CONFLICT(job_id, cron_id) DO UPDATE` — `INSERT OR REPLACE` is delete+insert (cascades on any unique index), `OR IGNORE` silently drops re-fold updates [sqlite.org/lang_conflict.html]
- **Wall-clock stays renderer-side:** spent/expired marking compares `Date.now()` in the TUI only; the fold derives status exclusively from event order
- **Skip cron-string parsing:** `tool_response.humanSchedule` already carries the display form; JS cron libraries diverge on dialect (5/6 fields, `#`, `L`, nicknames) so parsing for display is risk without payoff
- **Untrusted display text:** the cron prompt is freeform; truncate deterministically in the fold and render as plain text
