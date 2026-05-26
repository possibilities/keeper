## Description

**Size:** M
**Files:** `src/db.ts`, `src/types.ts`, `src/reducer.ts`, `src/collections.ts`,
`src/daemon.ts`, `test/db.test.ts`, `test/reducer.test.ts`

### Approach

Land the schema bump, the reducer's `InputRequest` arm, every clear path,
the daemon-side synthetic-event mint, and the projection-shape changes
as one atomic move. After this task the column pair
`(last_input_request_at, last_input_request_kind)` exists everywhere it
needs to (`jobs` row, `EmbeddedJob`, `EmbeddedJobElement`, `JobsRowForSync`,
`JobLinkEntry`), the reducer folds an `InputRequest` event by flipping
`state → 'stopped'` and stamping both columns under the same terminal
guard as `Stop` / `RateLimited`, and four clear arms zero the pair on
the right lifecycle events. No matcher / no board pill yet — the
transcript worker still emits zero `InputRequest` events; this task's
keystone is re-fold determinism.

Order of operations (single PR, logical sub-steps):

1. **Types first** (`src/types.ts`): widen `Job`, `EmbeddedJob`,
   `JobLinkEntry`, `EmbeddedJobElement`, `JobsRowForSync` with the new
   pair. Export `InputRequestKind` string-literal union (single member
   `"ask_user_question"` for now; TSDoc names `ExitPlanMode` + future
   interactive built-ins as planned additions, mirroring fn-616's
   `ApiErrorKind` rationale comment). Each field gets a TSDoc block
   citing the `InputRequest` reducer arm + the paired-NULL invariant
   (mirror `last_api_error_at` / `_kind`'s docs from fn-616).
2. **Schema** (`src/db.ts`): bump `SCHEMA_VERSION`. Add both column
   literals to `CREATE_JOBS` next to fn-616's `last_api_error_*` pair.
   Add the version-guarded ALTER step: `addColumnIfMissing(db, "jobs",
   "last_input_request_at", "REAL")` + same for `_kind TEXT`, followed
   by the rewind-and-redrain block (cursor rewind + `DELETE FROM
   epics`/`jobs` + re-drain) since `EmbeddedJob` gains the new pair —
   same pattern as v17→v18 rate_limited_at and fn-616's bump.
3. **Reducer** (`src/reducer.ts`):
   - New `InputRequest` arm — clone of `RateLimited` (`reducer.ts:2412-
     2443`). One UPDATE: `state='stopped'`, `last_input_request_at = ts`,
     `last_input_request_kind = <from event.data>`, terminal-guarded on
     `state NOT IN ('ended','killed')`, fans `syncIfPlanRef` only when
     `res.changes > 0`.
   - `UserPromptSubmit` arm (around `reducer.ts:2289-2367`): extend the
     existing rate-limit/api-error clear UPDATE to also `last_input_request_at
     = NULL, last_input_request_kind = NULL` — unconditional, cheap-on-NULL.
   - `SessionStart` arm: same unconditional clear.
   - `PreToolUse` arm: NEW clear UPDATE gated on `last_input_request_at
     IS NOT NULL` (hot path — fires per tool call). JSDoc comment
     explicitly cites "AskUserQuestion fires no hooks of its own; the
     closest 'answered' signal is the next tool the agent uses."
   - `PostToolUse` arm: same gated clear with the same comment.
   - `enrichJobLink()` (`reducer.ts:1696-1762`): extend the SELECT to
     read both new columns; zero-event seed branch returns NULL for
     both. Emit-order is locked (key-order tied to the fn-616 shape) —
     drift breaks byte-identical re-fold.
   - `syncJobLinksOnJobWrite()` (`reducer.ts:1856+`): add the new pair
     to the trigger column set so a stamp/clear on the linked jobs row
     re-stamps every `epics.job_links[]` entry that references it.
   - `buildEmbeddedJob()` (`reducer.ts:1312-1396`): read + write the
     new pair to embedded job JSON, mirroring fn-616's shape.
   - `syncIfPlanRef` SELECT (`reducer.ts:1605-1612`): add both columns.
4. **Collections** (`src/collections.ts:104`): add both columns to the
   `JOBS_DESCRIPTOR.columns` list next to fn-616's pair.
5. **Daemon mint** (`src/daemon.ts:271-345`): add the
   `if (msg.kind === "input-request")` arm to `transcriptWorker.onmessage`.
   Insert via `stmts.insertEvent.run({ ... hook_event: "InputRequest",
   event_type: "input_request", data: JSON.stringify({ kind:
   msg.requestKind }) })`. Every identity column (pid, start_time,
   tool_name, …) is NULL — synthetics never carry process identity.
   `wakePending = true; pumpWakes()`.

### Investigation targets

**Required** (read before coding):
- `src/reducer.ts:2412-2443` — `RateLimited` arm structural template.
- `src/reducer.ts:2272-2306` — `UserPromptSubmit` clear pattern (and
  the docstring's paired-NULL rationale).
- `src/reducer.ts:1696-1762` — `enrichJobLink()` — extend SELECT,
  preserve key-order.
- `src/reducer.ts:1605-1612` — `syncIfPlanRef` SELECT — add columns.
- `src/reducer.ts:1312-1396` — `EmbeddedJobElement`, `JobsRowForSync`,
  `buildEmbeddedJob` — widen.
- `src/db.ts:1460-1500` — v17→v18 rate_limited_at ALTER + rewind-and-redrain
  template (and the addColumnIfMissing/literal lockstep comment).
- `src/db.ts:432-560` — `CREATE_JOBS` literal — add both columns.
- `src/types.ts:298-330` and `:377-391` — `Job` / `EmbeddedJob` /
  `JobLinkEntry` TSDoc for `last_api_error_at` / `_kind` (post-fn-616).
  Mirror exactly.
- `src/daemon.ts:311-352` — `RateLimited` synthetic-event mint.
- `CLAUDE.md` "Event-sourcing invariants" + "DO NOT" — the constraints
  the rewind-and-redrain step must satisfy.

**Optional** (reference as needed):
- `test/reducer.test.ts:3588-3622` — `syncJobLinksOnJobWrite: RateLimited
  sets … revival clears it` test shape — mirror for InputRequest.
- `test/reducer.test.ts:3124+` — embedded-fixtures with
  `rate_limited_at: null` — add the new pair to fixture builders.

### Risks

- **Embedded-array hazard**: the rewind-and-redrain step is non-idempotent
  and version-guarded; a re-run on an already-migrated DB must short-
  circuit on `storedVersion >= N`. A bug here corrupts every existing
  epic's `tasks[].jobs[]` array.
- **`enrichJobLink` key-order**: both the populated and zero-event seed
  branches must emit keys in the same order as the fn-616 shape. JSON-
  stringify produces different bytes on key-order drift, silently
  breaking byte-identical re-fold without a test failure.
- **Hot clear path on PreToolUse / PostToolUse**: 50+ fires per turn.
  Forgetting the `IS NOT NULL` gate triggers thousands of no-op UPDATE
  per session.

### Test notes

- Reducer: one parameterized test that asserts InputRequest stamps both
  columns + flips state, then each of the four clear arms zeros both
  columns and leaves the rest of the row untouched. Cover the
  terminal-guard branch (`InputRequest` on `state='ended'` is a no-op).
- `syncJobLinksOnJobWrite`: assert a jobs-write touching the new pair
  re-stamps `epics.job_links[]` entries on every linked epic.
- From-scratch re-fold determinism: an event sequence with `InputRequest`
  + a clear arm; rewind cursor + `DELETE FROM jobs/epics` + re-drain;
  assert byte-identical `jobs` rows AND embedded arrays.
- `db.test.ts`: a populated v(N-1) DB migrates to v(N) and the rewind
  produces the same embedded shape as a fresh v(N) build.

## Acceptance

- [ ] `CREATE_JOBS` literal carries both columns; `addColumnIfMissing`
      ALTER step exists; rewind-and-redrain is version-guarded.
- [ ] `SCHEMA_VERSION` bumped exactly once.
- [ ] Reducer's `InputRequest` arm clones `RateLimited`'s shape: one
      UPDATE, terminal-guarded, syncs only on `res.changes > 0`.
- [ ] `UserPromptSubmit` + `SessionStart` clear unconditionally;
      `PreToolUse` + `PostToolUse` clear gated on
      `last_input_request_at IS NOT NULL`.
- [ ] `enrichJobLink`, `syncJobLinksOnJobWrite`, `buildEmbeddedJob`,
      `syncIfPlanRef`, `JOBS_DESCRIPTOR.columns` all carry the new pair
      with byte-identical key-order.
- [ ] Daemon mints `InputRequest` synthetic events from
      `{kind:"input-request"}` worker messages.
- [ ] `bun test` passes; new tests cover stamp, all four clear arms,
      terminal guard, link fan-out, re-fold determinism, and v(N-1)→v(N)
      migration parity.

## Done summary
Landed schema v25: jobs.last_input_request_at + last_input_request_kind columns, InputRequest reducer arm (clone of RateLimited/ApiError shape with terminal guard), four clear arms (UserPromptSubmit + SessionStart unconditional; PreToolUse + PostToolUse gated on IS NOT NULL), daemon synthetic-event mint, and widened enrichJobLink/syncJobLinksOnJobWrite/buildEmbeddedJob/syncIfPlanRef/JOBS_DESCRIPTOR with locked key-order. New tests cover stamp + terminal guard, allow-list fallback, all four clear arms, gate keeps last_event_id steady, rewind-and-redrain re-fold determinism, link fan-out, and v24→v25 migration parity.
## Evidence
