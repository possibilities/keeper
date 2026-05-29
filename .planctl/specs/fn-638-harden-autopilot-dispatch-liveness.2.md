## Description

**Size:** S
**Files:** scripts/autopilot.ts, test/autopilot.test.ts

Close P1 (root cause): autopilot spawns bare `claude '/plan:<verb> <id>'`
with no `--name`, so the SessionStart hook scrapes `spawn_name=null`, the
deriver yields `plan_ref=null`, `syncJobIntoEpic` no-ops, and the worker
session never enters the embedded `task.jobs[]` array — making it invisible
to the readiness predicates and the per-root mutex. Restoring `--name`
reconnects the existing end-to-end linkage contract.

### Approach

At the real dispatch sites in `processLaunchTransitions`
(`scripts/autopilot.ts:1670-1729`: work `:1673`, approve-task `:1684`,
close `:1710`, approve-close `:1721`), pass `--name <verb>::<id>` on the
`claude` invocation, placed before the `'/plan:<verb> <id>'` prompt
positional. `work` uses the **task** id (`fn-N-slug.M`); `close` and
`approve` use the **epic** id (`fn-N-slug`, no `.M`). The emitted string
must match the deriver regex `^(plan|work|close|approve)::(fn-\d+-[a-z0-9-]+(?:\.\d+)?)$`
exactly (no `cd` leakage, no trailing space). Do NOT touch the display
builders `renderEpicCommands`/`renderEpicCommandsFiltered`
(`:289-366`) — they have byte-exact assertions at
`test/autopilot.test.ts:106-138`. Verify the name survives the
`launchInGhostty` quoting chain (`/bin/zsh -l -i -c` + AppleScript) to reach
the SessionStart `ps` scrape unmangled — the `word::fn-…` charset has no
shell metacharacters, but confirm with a manual smoke.

### Investigation targets

**Required** (read before coding):
- scripts/autopilot.ts:1670-1729 — the real dispatch sites (work/approve-task/close/approve-close)
- scripts/autopilot.ts:1477-1559 — `launchInGhostty` quoting chain
- src/derivers.ts:88 — `planVerbRefFromSpawnName` regex the `--name` must match
- plugin/hooks/events-writer.ts:125 — `nameFromArgs` scrape; :273/:478 — SessionStart `spawn_name` freeze
- src/reducer.ts:2687 — `syncJobIntoEpic` gated on `plan_ref != null`

**Optional** (reference as needed):
- scripts/autopilot.ts:289-366 + test/autopilot.test.ts:106-138 — display builders (DO NOT change; byte-exact tests)

### Risks

- Quoting breakage silently kills linkage (and task `.3`, which depends on `findSessionJob` matching `plan_verb`). A broken channel fails closed and quietly.
- `close`/`approve` must use the epic id, `work` the task id — wrong id form fails the deriver regex.

### Test notes

Assert the command string emitted at each dispatch site contains
`--name <verb>::<id>` with the correct id form per verb. Keep the
display-builder byte tests green. Manual smoke: dispatch, then confirm
`jobs.plan_ref` is populated for the spawned session.

Depends on `.1` (bounded Stop guard) so guard-first ordering closes the
regression window: once a worker links, a stuck orphan sub-agent could hold
the root mutex — the guard must exist before linking is enabled.

## Acceptance

- [ ] `--name <verb>::<ref>` emitted at all four dispatch sites, matching the deriver regex (work=task id, close/approve=epic id)
- [ ] Display builders unchanged; their byte-exact tests stay green
- [ ] Spawned session links: `jobs.plan_ref` populated, session enters embedded `task.jobs[]`
- [ ] Name survives the launchInGhostty quoting chain (verified)

## Done summary
Closed the autopilot→keeper linkage gap (P1 root cause). All four real dispatch sites in processLaunchTransitions now route through a new exported buildClaudeDispatchCommand helper that emits --name <verb>::<id> matching SPAWN_VERB_REF_RE; work uses task id, close/approve-close use epic id, approve-task uses task id. Display builders untouched (byte-exact tests stay green). Six new unit tests pin the deriver-regex contract, per-verb id form, empty-projectDir no-cd path, and the single-token/no-shell-metachar invariants the ps -o args= scrape and launchInGhostty quoting chain depend on.
## Evidence
