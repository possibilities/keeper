## Description

**Size:** M
**Files:** src/daemon.ts, src/reducer.ts, src/types.ts, test/reducer.test.ts (or the relevant reducer test file), test/refold-equivalence.test.ts

Add the synthetic `SessionTelemetry` event's serialize/decode and the reducer fold arm that
lands its values on the `jobs` columns from `.1`. Pure daemon/reducer side — testable with
synthetic events, no worker required.

### Approach

Add `serializeSessionTelemetry(msg)` in `src/daemon.ts` mirroring `serializeUsageSnapshot`
(`:1175`) — flatten `{model_id, model_display, effort, used_percentage, input_tokens,
window_size}` into the event `data` blob. Add a `SessionTelemetryPayload` type in
`src/types.ts` and `extractSessionTelemetry(event)` in `src/reducer.ts` mirroring
`extractUsageSnapshot` (`:2890`): guarded `JSON.parse`, every field a null-fallback, NEVER
throws, unknown → null.

Add a `case "SessionTelemetry"` arm to `projectJobsRow` (`:7643`) modeled on the `ApiError` arm
(`:8134`) — a partial `UPDATE jobs SET <present cols>=?, last_event_id=?, updated_at=? WHERE
job_id=? AND state NOT IN ('ended','killed')` — but with three critical differences from
ApiError: (1) write ONLY the six telemetry columns + `last_event_id` + `updated_at`, NEVER
`state`/`active_since`; (2) do NOT `syncIfPlanRef`; (3) a partial payload updates only its
present fields (COALESCE semantics) so an effort-only event does not null model/context. An
event arriving before `SessionStart` matches zero rows — that is the correct no-op; never
UPSERT-mint a phantom jobs row. Register the arm in the outer `applyEvent` dispatch (`:8812`
style) and add `"SessionTelemetry"` to `KEEP_SET_HOOK_EVENTS` in
`test/refold-equivalence.test.ts:128`. Use `event_type = "session_telemetry"`.

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:1175 — serializeUsageSnapshot (serialize template)
- src/reducer.ts:2890 — extractUsageSnapshot (guarded-decode template); :2841 payload type
- src/reducer.ts:8134 — the ApiError jobs arm (mirror the UPDATE shape; AVOID its state flip)
- src/reducer.ts:7643 — projectJobsRow (jobId = event.session_id); :8812 the outer dispatch arm
- test/refold-equivalence.test.ts:128 — KEEP_SET_HOOK_EVENTS

**Optional** (reference as needed):
- src/reducer.ts:3001 — projectUsageRow (fold-shape reference)

### Risks

Touching `state`/`active_since` would corrupt the job lifecycle (the ApiError arm does it; this arm
must NOT). Forgetting to add `"SessionTelemetry"` to `KEEP_SET_HOOK_EVENTS` makes re-fold silently
diverge (the shed drops the event body). A throw inside the fold violates never-throw-in-fold.
Folding a keeper-derived % (rather than the raw observed `used_percentage`) would break byte-identity.

### Test notes

Reducer unit tests over synthetic `SessionTelemetry` events: updates only telemetry columns and
leaves `state` untouched; no-ops cleanly before `SessionStart`; a partial payload preserves the
other fields; malformed `data` folds to a safe value without throwing. `test/refold-equivalence.test.ts`
stays byte-identical with the event in `KEEP_SET_HOOK_EVENTS`.

## Acceptance

- [ ] `SessionTelemetry` folds onto the six jobs columns without touching `state`/`active_since` and without `syncIfPlanRef`
- [ ] A pre-`SessionStart` event is a clean zero-row no-op (no phantom jobs row)
- [ ] Partial payloads merge (effort-only leaves model/context intact); malformed `data` never throws
- [ ] `"SessionTelemetry"` is in `KEEP_SET_HOOK_EVENTS`; two from-scratch re-folds are byte-identical
- [ ] `bun test` green

## Done summary
Added serializeSessionTelemetry (daemon) + extractSessionTelemetry (reducer) and a jobs-only COALESCE-merge SessionTelemetry fold arm landing the six v100 telemetry columns without touching state/active_since; added to KEEP_SET_HOOK_EVENTS for byte-identical re-fold.
## Evidence
