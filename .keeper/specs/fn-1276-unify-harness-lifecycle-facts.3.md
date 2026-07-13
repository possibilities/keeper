## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/reconcile-core.ts, src/dispatch-command.ts, src/birth-record.ts, src/birth-ingest-worker.ts, src/reducer.ts, plugins/keeper/plugin/hooks/events-writer.ts, plugins/keeper/pi-extension/keeper-events.ts, test/autopilot-worker.test.ts, test/dispatch-command.test.ts, test/birth-record.test.ts, test/birth-ingest-worker.test.ts, test/reducer-projections.test.ts, test/pi-extension.test.ts

### Approach

Mint the Dispatch-attempt identity before backend execution and carry it as generic metadata through the top-level dispatcher into Claude SessionStart and Pi birth ingestion. Bind a Harness session only when the carried identity matches the current claim; exact duplicates are harmless, stale or missing identities remain unfenced, and Pi extension failures stay fail-open.

This is metadata plumbing, not launch choreography: preserve verb prompts, worker-cell selection, command intent, tmux naming, and `/work`/`close` child behavior. Do not add harness-name policy branches downstream; expose capability through the descriptor/adapter boundary and leave Codex/Hermes unchanged.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/reconcile-core.ts:426-485` — generic worker command and launch assembly boundary.
- `src/autopilot-worker.ts:2100-2130` — dispatch intent production before backend execution.
- `src/birth-ingest-worker.ts:1-31` — non-Claude launcher birth records and synthetic SessionStart ownership.
- `src/reducer.ts:8068-8088,8260-8305` — SessionStart plan-key derivation and dispatch-origin binding.
- `plugins/keeper/pi-extension/keeper-events.ts:1-49,209-300` — isolated fail-open Pi lifecycle adapter.
- `src/agent/harness.ts:125-240` — capability registry and hook-mechanism boundary.

**Optional** (reference as needed):
- `plugins/keeper/plugin/hooks/events-writer.ts` — Claude hook event envelope and environment boundary.
- `test/pi-extension.test.ts:58-145` — inline golden lifecycle fixtures.
- `test/birth-ingest-worker.test.ts` — synthetic SessionStart ingestion fixtures.

### Risks

Missing metadata cannot silently fall back to key-only binding. Adding metadata to shell construction must remain injection-safe and must not expose tokens in human-facing titles. The Pi adapter cannot import keeper source and must degrade to unfenced/unknown without crashing the turn.

### Test notes

Assert attempt carriage and exact binding for Claude and Pi, late old SessionStart after a newer claim, duplicate starts, absent/malformed carrier, manual SessionStart, recycled process identity, and Pi adapter failure. Snapshot existing dispatch command intent to prove only the metadata envelope changes.

### Detailed phases

1. Mint the attempt at dispatch admission and attach it to the backend execution envelope.
2. Carry it through Claude hooks and Pi birth/session events without changing display titles or prompts.
3. Exact-bind SessionStart to the current claim and preserve manual/legacy-unfenced classification on absence.
4. Add adapter capability and golden fixtures for Claude/Pi while preserving other harnesses.
5. Exercise stale, duplicate, missing, malformed, and recycled-identity schedules.

### Alternatives

Encoding the attempt in a session title was rejected because titles are mutable display data. Correlating only by process timing or `(verb, ref)` was rejected because delayed starts remain ambiguous.

### Non-functional targets

Attempt metadata is opaque, bounded, non-secret, and never interpolated unsafely into a shell. Hook and Pi adapter paths retain their dep-free/fail-open contracts and emit bounded records.

### Rollout

Dual-read legacy/unfenced behavior remains until pre-change sessions end. The producer may begin writing attempt metadata before consumers switch; reverting the carrier leaves durable claims inert rather than corrupting attribution.

## Acceptance

- [ ] Every new Claude/Pi autopilot dispatch carries an opaque Dispatch-attempt identity from admission through SessionStart/birth binding.
- [ ] A Harness session binds only the matching current claim; stale, duplicate, missing, malformed, and manual starts receive the specified idempotent or unfenced outcomes.
- [ ] Delayed old starts cannot consume a newer claim or inherit its dispatch provenance.
- [ ] Pi adapter failure remains fail-open and yields unknown/unfenced evidence rather than a crash or guessed owner.
- [ ] `/work` and `/close` prompts, selected cells, display titles, and child-launch behavior are unchanged apart from generic metadata carriage; Codex/Hermes behavior is unchanged.
- [ ] Dispatch, birth-ingest, reducer, and Pi golden suites pass in process isolation.

## Done summary
Minted an opaque Dispatch-attempt identity at admission and carried it through the generic backend envelope into Claude SessionStart and Pi birth ingestion, exact-binding a Harness session to its current claim while keeping stale/duplicate/missing/malformed/manual starts on the existing idempotent or unfenced paths; verb prompts, cell selection, titles, and Codex/Hermes behavior are unchanged.
## Evidence
