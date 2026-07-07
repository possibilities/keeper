## Description

**Size:** S
**Files:** src/snapshot.ts, src/frames-emitter.ts, test/snapshot.test.ts, test/frames-emitter.test.ts

### Approach

Machine-facing surfaces stamp catch-up state and never block. Add a tri-state
catching_up (boolean or null) to SnapshotMeta — the keeper-meta trailer — and to
both FrameRecord and TrailerRecord: null means no boot header was observed this run,
false means steady state observed, true means the freshest header reported
catch-up. Bump BOTH version constants per each file's own bump-on-any-field-shape-change
rule (SNAPSHOT_SCHEMA_VERSION and FRAMES_SCHEMA_VERSION); they are separate
constants that never share a value. The emitters take the value as caller input
through their existing injectable seams and default safely to null — threading live
values from the view shells lands in the dependent tasks, so this task's surface is
the contract plus defaults only. A snapshot taken during catch-up still emits its
frame and trailer stamped true; the snapshot timeout path stamps whatever was
observed.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/snapshot.ts:41-45 — SNAPSHOT_SCHEMA_VERSION and the keeper-meta prefix
- src/snapshot.ts:70 — SnapshotMeta interface
- src/snapshot.ts:276-330 — trailer serialization and label lines
- src/frames-emitter.ts:30-31 — FRAMES_SCHEMA_VERSION and its bump rule
- src/frames-emitter.ts:67-101 — FrameRecord and TrailerRecord
- test/snapshot.test.ts:254 — sampleMeta literal to update

**Optional** (reference as needed):
- test/schema-version.test.ts — confirm it gates only the DB schema version (neither envelope constant is whitelisted there)
- docs/adr/0012-agent-frame-stream-wire-contract.md — the envelope contract this extends

### Risks

- A consumer hard-pinning schema_version 1 would reject the new envelopes; verify no in-repo consumer pins, and rely on the version bump as the honest signal.

### Test notes

Extend the existing envelope-shape assertions: field present on all record kinds,
both constants bumped and distinct, null default when nothing is injected, snapshot
during catch-up terminates normally.

## Acceptance

- [ ] The snapshot keeper-meta trailer and both frames record kinds carry a tri-state catching_up field defaulting to null when never observed
- [ ] Both envelope schema-version constants are bumped and remain distinct
- [ ] A snapshot or frames run during catch-up still terminates normally with stamped records, never blocked
- [ ] Envelope suites cover the new field on every record kind and the null default

## Done summary

## Evidence
