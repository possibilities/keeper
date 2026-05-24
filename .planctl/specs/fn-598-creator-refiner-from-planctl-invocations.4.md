## Description

**Size:** S
**Files:** plugin/hooks/events-writer.ts, src/db.ts, test/events-writer.test.ts

### Approach

At hook-write time, on every event the hook stages for `insertEvent`,
call `extractPlanctlInvocation(hookEvent, toolName, data)` next to the
existing `slashCommandFromPrompt` and `extractSkillName` calls. Bind the
five returned fields (`planctl_op`, `planctl_target`, `planctl_epic_id`,
`planctl_task_id`, `planctl_subject_present`) as named params on the
`insertEvent` prepared statement.

Update `src/db.ts:854-878` (the `insertEvent` prepared statement and its
named-bindings) to carry the five new `$planctl_*` columns.

Defensive against the hook's exit-0 contract: a null deriver return →
all five params bind to `null`. Never throw. The deriver itself is
already defensive (task .1).

### Investigation targets

**Required** (read before coding):
- `plugin/hooks/events-writer.ts:319-330` — the existing deriver invocation site (where `slashCommandFromPrompt` + `extractSkillName` are called).
- `plugin/hooks/events-writer.ts:356-375` — the existing `insertEvent` named-bindings block (where `$slash_command` / `$skill_name` already live).
- `src/db.ts:854-878` — `prepareStmts.insertEvent` SQL + bindings.
- `src/derivers.ts` (just-completed task .1 exports).

**Optional**:
- `test/events-writer.test.ts:43-91` — hook integration via spawn-launcher pattern.
- `CLAUDE.md` "The hook must always exit 0" + "No third-party deps in the hook" — hard invariants this task lives under.

### Risks

- Hook 1.5s SessionEnd budget: the new deriver adds one regex test + one substring split. Microbenchmark before-after to confirm no measurable degradation.
- Hook import-graph creep: confirm `src/plan-classifier.ts` is NOT imported (transitively or directly) from the hook. The hook imports `src/derivers.ts` only.

### Test notes

One hook integration test (spawn-launcher pattern) that drives a real
hook with a Bash command `planctl epic-create fn-N-foo "subject"` in
`tool_input.command`, then asserts the resulting events row carries the
expected five `planctl_*` column values. One negative case: a non-planctl
Bash command (e.g. `ls`) → all five NULL.

## Acceptance

- [ ] Hook calls `extractPlanctlInvocation` and binds five `$planctl_*` params on every event.
- [ ] `insertEvent` prepared statement carries the five new columns.
- [ ] Hook integration test passes for planctl + non-planctl Bash commands.
- [ ] Hook never throws on any event (including malformed `data`).
- [ ] Hook microbenchmark: cold-start + per-event overhead unchanged (no regression).

## Done summary
Wired extractPlanctlInvocation into the events-writer hook: the deriver is called on every event next to slashCommandFromPrompt/extractSkillName, the five planctl_* params bind on the insertEvent prepared statement (which now lists the new columns), synthetic daemon inserts bind NULL, and five new hook integration tests cover mutation+task-ref+non-planctl+wrong-hook+malformed-command paths.
## Evidence
