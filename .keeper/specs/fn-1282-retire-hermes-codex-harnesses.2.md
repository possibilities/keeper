## Description

**Size:** M
**Files:** src/agent/codex-session-index.ts, src/codex-state-worker.ts, src/daemon.ts, cli/autopilot.ts, src/rpc-handlers.ts, src/collections.ts, src/birth-record.ts, src/birth-ingest-worker.ts, test/agent-codex-session-index.test.ts, test/codex-adoption.test.ts, test/codex-resume.test.ts, test/codex-state.test.ts, test/birth-record.test.ts, test/birth-ingest-worker.test.ts, test/rpc-handlers.test.ts

### Approach

Delete rollout attribution, resume backfill, stop tailing, adoption, Codex birth semantics, and the active adoption control plane. Preserve the adjacent Pi repair sweep and generic Pi birth ingestion.

### Investigation targets

*Verify before relying — these refs move with the repo.*

**Required** (read before coding):
- `src/daemon.ts:12533` — combined Codex/Pi maintenance timer.
- `src/agent/codex-session-index.ts` — rollout attribution/adoption.
- `src/codex-state-worker.ts` — stop producer.
- `cli/autopilot.ts:1442` and `src/rpc-handlers.ts:472` — adoption API.
- `src/birth-record.ts:1` — Pi-shared birth contract.

**Optional** (reference as needed):
- `plugins/keeper/pi-extension/keeper-events.ts` — retained lifecycle source.

### Risks

Removing the combined timer or generic `ResumeTargetResolved` event can regress Pi.

### Test notes

Remove dedicated Codex lifecycle tests, keep Pi repair/birth coverage, reject the adoption key, and enforce birth schema plus Pi membership.

### Detailed phases

1. Remove Codex queries, timers, cursors, stop mints, and adoption.
2. Extract the unchanged Pi repair timer.
3. Remove adoption CLI/RPC/collection fields, leaving the column for task 3.
4. Restrict birth records to Pi and delete dedicated modules/tests.

### Alternatives

A dormant default-off producer is rejected because it remains harness support.

### Non-functional targets

Pi repair stays bounded and fail-open; malformed births never throw inside a fold.

### Rollout

Land before task 3 drops the column.

## Acceptance

- [ ] The daemon performs no Codex rollout, target, tail, or adoption work.
- [ ] CLI/RPC/collections expose no adoption setting.
- [ ] Pi repair and birth ingestion retain behavior and tests.
- [ ] Unsupported or wrong-version births cannot mint jobs.

## Done summary
Removed Codex daemon lifecycle producers (rollout attribution, resume backfill, stop tailing, timers) and the codex_adoption CLI/RPC/collection control surface, while preserving the Pi repair sweep. Restricted birth records/ingestion to Pi and rejected unsupported/wrong-version births before they can mint jobs. Left the codex_adoption schema column in place for a later task.
## Evidence
