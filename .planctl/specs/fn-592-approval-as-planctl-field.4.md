## Description

**Size:** M
**Files:** `scripts/autopilot.ts`, `scripts/approve.ts` (no test file rewrites -- these are integration CLIs without unit tests in this repo)

### Approach

`scripts/autopilot.ts`: (a) delete the entire `approvalsWorker` instantiation, its `ConnectionWorker` factory call, the `approvalsByKey` map, the second `Bun.connect` socket lifecycle, the second SIGINT-shutdown branch; (b) drop the virtual `close:<epic_id>` row in `renderBody`; (c) replace pill-state lookup: `epic.approval` for the epic-level pill (rendered next to `- epic: <epic_id>` as ` [<approval>]`), `task.approval` for the per-task pill (rendered next to each `- <task_id>`); (d) default `epicsFilter` to `{ approval: { ne: "approved" } }` (composed with server's `{ status: "open" }` default); (e) add `--show-approved` flag that disables ONLY the approval filter (status filter remains via server default); (f) update the file header docstring + `HELP` constant; (g) drop the schema-v12 tolerance comment and the "old daemon, unknown_collection" branch (no longer relevant -- there is no `approvals` collection).

`scripts/approve.ts`: (a) replace single-RPC routing with two-RPC routing: positionals `<epic_id> <status>` -> `set_epic_approval`; `<epic_id> <task_id> <status>` -> `set_task_approval`; (b) status vocabulary `clear` -> `pending` (hard cut, no alias); (c) update HELP, error messages, exit codes; (d) keep the single-shot RPC client pattern (`resolveSockPath`, `crypto.randomUUID` rpc id, encode/decode frames).

### Investigation targets

**Required** (read before coding):
- `scripts/autopilot.ts:257-486` -- `createConnectionWorker` factory (keep, instantiate once)
- `scripts/autopilot.ts:537-599` -- `renderBody` (drop close: row, simplify pill lookup)
- `scripts/autopilot.ts:689-707` -- `epicsFilter` construction (default + flag handling)
- `scripts/autopilot.ts:1-90` -- file header docstring (rewrite to single-subscription)
- `scripts/approve.ts:106-298` -- single-shot RPC client pattern (carry over to two-RPC routing)

**Optional:**
- `src/protocol.ts` -- `encodeFrame` / `FilterValue` / `QueryFrame` (no protocol change needed)

### Risks

- autopilot's `lastBody` byte-compare emit gate must still work -- verify rendering with approval pills on both epic line and task lines produces stable output (no whitespace drift).
- approve.ts vocabulary change is breaking -- the "ship docs last" rollout note covers the operator-facing announcement.

### Test notes

No new unit tests (scripts are integration CLIs). Manual verification with autopilot.ts + approve.ts + a running keeperd: (a) approve an epic, see pill flip and epic drop from default view; (b) `--show-approved` brings it back; (c) approve a task, see task pill flip; (d) `pending` resets state; (e) lifecycle notes still narrate connect/disconnect/wait.

## Acceptance

- [ ] autopilot uses ONE `Bun.connect` socket (no `approvalsWorker`, no `approvalsByKey`)
- [ ] No virtual `close:<epic_id>` row in render
- [ ] Epic-level pill renders from `epic.approval`; per-task pill renders from `task.approval`
- [ ] Default filter `{ status: "open", approval: { ne: "approved" } }` hides approved epics by default
- [ ] `--show-approved` flag disables ONLY the approval filter
- [ ] File header docstring + HELP describe the new single-subscription shape
- [ ] `approve.ts` routes `<epic_id> <status>` -> `set_epic_approval`, `<epic_id> <task_id> <status>` -> `set_task_approval`
- [ ] Status vocabulary is `approved | rejected | pending`; no `clear`

## Done summary
Rewrote autopilot.ts to a single epics subscription that reads approval pills from epic.approval and embedded task.approval (schema v13), with --show-approved disabling only the approval default filter. Rewrote approve.ts to route by positional arity (2 args -> set_epic_approval, 3 args -> set_task_approval) with vocabulary approved|rejected|pending (no clear).
## Evidence
