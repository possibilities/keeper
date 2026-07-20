## Description

Source finding: F1 (evidence: src/daemon.ts:12787). The events-ingest worker
onmessage handler calls runEventsIngestStallDistressStep() after every
successful live ingest; that step calls probeEventsLogBacklog (src/daemon.ts:7497 —
readdirSync + per-file statSync + per-file SELECT) on the main thread. A stall is
the absence of ingest, which produces no onmessage event, so only the 3s
eventsIngestFallbackTimer (src/daemon.ts:17339) can ever mint the distress. Remove
the redundant onmessage invocation (src/daemon.ts:12786-12794) so the probe runs
only on the fallback cadence, keeping the hot ingest path free of the per-message
fs+DB probe. Preserve the fallback-timer invocation and the existing non-fatal
try/catch guard. Confirm the stall mint/clear path still behaves per the audited
feature.

Files: src/daemon.ts (onmessage handler and stall-distress step).

## Acceptance

- [ ] The onmessage stall-probe invocation is removed; ingest onmessage no longer runs probeEventsLogBacklog.
- [ ] The 3s fallback-timer stall-distress step is retained and stall mint/clear behavior is unchanged.
- [ ] Existing stall-distress and ingest tests stay green (add coverage if the removal is not otherwise exercised).

## Done summary

## Evidence
