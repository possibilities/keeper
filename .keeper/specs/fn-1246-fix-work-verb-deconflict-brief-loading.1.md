## Description

Fixes finding F1 (merges F4 + F5). Evidence path, confirmed at commit a9ac5814:

- `src/daemon.ts:11610` `dispatchWorkDeconflict` launches `/plan:deconflict <taskId>`
  (row.id is a task id) for a stuck work fan-in conflict.
- `cli/escalation-brief.ts:220-223` `parseEscalationKey` requires `ref.kind === "epic"`
  for `deconflict::`, so a task-form ref returns `null` → `unparseable_key`.
- `cli/escalation-brief.ts:447-448` `buildDeconflictIncident` hard-filters
  `dispatch_failures WHERE verb = 'close'`, so a work row is never found.
- The fn-1240 commit set never touched `cli/escalation-brief.ts` nor the deconflict skill.

Files:
- `cli/escalation-brief.ts` — extend `parseEscalationKey` to accept a task-form ref for
  `deconflict::` (carry the task_id and derive the epic_id from it for the epic-keyed
  lineage/primary-repo lookup), and generalize `buildDeconflictIncident` to look up the
  sticky row by `verb IN ('close','work')` keyed on the ref's own id.
- `plugins/plan/skills/deconflict/SKILL.md` — generalize the epic-only framing so the
  skill reads correctly on either a `deconflict::<epic>` or a `deconflict::<taskId>` ref,
  including its retry step (`keeper autopilot retry close::<epic>` vs `work::<taskId>`)
  and the "never write in another task's lane" guard for the work-lane case.
- `test/escalation-brief.test.ts` — add the end-to-end coverage.

Keep the close-verb path byte-identical (the `verb` default stays `close`; legacy
`deconflict::<epic>` refs and their brief output are unchanged).

## Acceptance

- [ ] `keeper escalation-brief deconflict::<taskId>` returns `ok` with a parseable incident for a sticky work-verb merge-conflict row.
- [ ] `deconflict::<epic>` output and the close path are unchanged (byte-identical brief).
- [ ] The `deconflict` skill's guidance and retry step read correctly for a task-form ref.
- [ ] A test drives `keeper escalation-brief deconflict::<taskId>` end-to-end and asserts a parseable brief (the daemon-to-skill handoff F5 exercises).

## Done summary

## Evidence
