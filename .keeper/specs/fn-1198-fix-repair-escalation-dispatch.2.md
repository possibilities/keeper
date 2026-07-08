## Description

**Size:** S
**Files:** src/daemon.ts, test/daemon.test.ts

### Approach

Make every silent candidate-drop gate in the repair/block escalation sweeps observable: when a pending escalation row is skipped (wrong runtime status, unreadable reason, non-routing category, empty repo token, cap/occupancy park), emit a bounded, class-stable diagnostic naming the row key and the gate — through the existing daemon logging surface, not a new needs-human family (a dropped candidate is telemetry until it persists; the sticky machinery already covers persistence). Class-stable means the message never embeds a live age or attacker-influenced reason text beyond a bounded, quoted snippet — no re-fire churn, no injection into downstream consumers.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:9866 — the gates being instrumented (post task-1 shape)
- Existing daemon log-line conventions (bracketed subsystem prefixes) — match them

### Risks

- Noise: a busy board with many benign skips must not flood the log — dedupe per (row, gate) per sweep cycle.

### Test notes

Unit at the sweep seam: injected deps capture the diagnostic sink; assert one line per dropped candidate naming the gate, deduped across a repeated sweep on unchanged state.

## Acceptance

- [ ] Every candidate-drop gate emits exactly one class-stable diagnostic per (row, gate) per sweep cycle, observable in the daemon log surface
- [ ] Diagnostics never interpolate unbounded or unquoted reason text
- [ ] keeper fast suite green

## Done summary
Instrumented runBlockEscalationSweep's candidate-drop/skip gates (not_blocked, reason_unreadable, repair, surface_and_stop, empty_repo, epic_serialized, at_cap/already_live/checkout_busy) with class-stable note() diagnostics, mirroring the repair sweep's fn-1198.1 instrumentation; added a new empty-repo defensive guard and extended/added daemon.test.ts coverage for all classes plus repeat-sweep determinism.
## Evidence
