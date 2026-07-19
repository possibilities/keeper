## Description

**Size:** M
**Files:** src/bus-worker.ts, src/bus-artifact.ts, cli/bus.ts, test/bus-worker.test.ts, test/bus-cli.test.ts, README.md, docs/agent-surface-contracts.md, plugins/keeper/skills/bus/SKILL.md, plugins/keeper/skills/watch/SKILL.md

### Approach

Extend the synchronous publish acknowledgement with an optional `recipient_activity` object containing canonical `status`, `reason`, and Unix-seconds `observed_at`; Dispatch reservation and lower-level process/session details stay excluded. For a resolved stable recipient, read the parent and attributable child/resource evidence in one consistent read-only SQLite snapshot, derive activity once through `deriveHarnessActivity` immediately before fanout, and attach the snapshot only when the final outcome is `delivered`. A missing stable identity or any read, partial-read, validation, or compatibility failure omits the field; a complete canonical derivation may explicitly return `unknown`.

Keep the field additive across the shared decoder and every caller: absent, malformed, or future activity values preserve the existing `{result, recipients}` behavior. Render conservative CLI suffixes for valid snapshots while preserving the exact old line when metadata is absent; retain current output and behavior for `queued_for_wake` and every failure outcome. Documentation must distinguish socket acceptance from activity and consumption, and no lifecycle transition may emit a later receipt.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/bus-worker.ts:1640` — directed publish ordering, provisional persistence, pre-fanout boundary, outcome reconciliation, and acknowledgement.
- `src/session-activity.ts:111` — canonical tri-state derivation, reason vocabulary, child/resource handling, and stale/incomplete evidence behavior.
- `src/readiness-inputs.ts:145` — existing projection-read and Harness activity derivation pattern.
- `src/bus-identity.ts:354` — stable job identity and live-fallback behavior where `identity` may be absent.
- `src/bus-artifact.ts:150` — shared `BusSendResult` type and compatibility boundary.
- `src/bus-artifact.ts:646` — one-shot publish acknowledgement decoder used by CLI and non-CLI consumers.
- `cli/bus.ts:855` — send-result disposition, exact success rendering, and unchanged exit-code semantics.
- `test/bus-worker.test.ts:204` — delivery truth table that activity enrichment must not alter.
- `test/bus-cli.test.ts:713` — pinned success/error disposition and current output strings.
- `docs/adr/0093-agent-bus-recipient-activity-snapshot.md:1` — accepted timing, omission, compatibility, and no-follow-up contract.

**Optional** (reference as needed):
- `src/subagent-invocations.ts:1` — canonical child-invocation selection already consumed by the activity derivation.
- `src/agent/run-capture.ts:1001` — non-CLI consumer for which an acknowledgement is never an answer boundary.
- `src/provider-leg-death-notice.ts:711` — non-CLI shared sender that must remain compatible.
- `plugins/keeper/skills/bus/SKILL.md:74` — primary agent-facing send semantics.
- `plugins/keeper/skills/watch/SKILL.md:546` — supervisory guidance that references send outcomes.

### Risks

Sampling after fanout can misreport an idle Pi recipient as active because delivery may trigger its turn; preserve the pre-fanout boundary. Deriving from a stopped parent after a child query fails can falsely report quiescence, so partial evidence failure must omit the whole snapshot. Synchronous reads run on the Bus serve path and must stay indexed and bounded. CLI copy must not turn `active` into “processing” or `quiescent` into “available.”

### Test notes

Cover main-turn active, stopped/quiescent, stopped with an active child/resource, canonical unknown, absent identity, projection/read failure, partial evidence failure, and the proof that sampling occurs before fanout. Pin that only `delivered` can carry metadata, old acknowledgements keep exact output, valid snapshots add conservative suffixes, malformed/future objects are ignored, all exit codes remain unchanged, and no automatic follow-up frame is generated. Retain shared-consumer coverage for Partner capture and Provider-leg notices.

## Acceptance

- [ ] A delivered publish acknowledgement may contain `recipient_activity: { status, reason, observed_at }`, where status and reason come from the canonical Harness activity derivation and the observation is sampled once before fanout.
- [ ] `recipient_activity` is emitted only for `delivered`; no stable recipient identity or any failed/partial evidence read omits it, while a successful inconclusive derivation emits canonical `unknown`.
- [ ] Activity enrichment never gates fanout, changes the delivery result or recipient count, alters exit codes, persists activity, adds a writer, or requires a schema migration.
- [ ] The shared decoder accepts old acknowledgements and ignores malformed or future activity metadata without changing base send behavior for CLI, Partner capture, or Provider-leg notices.
- [ ] Valid active, quiescent, and unknown snapshots add conservative send-time guidance; absent metadata preserves the exact existing success line, and queued/failure output remains unchanged.
- [ ] Documentation consistently states that `delivered` is socket acceptance, activity is a point-in-time observation, and no automatic lifecycle-derived receipt is sent.
- [ ] Focused Bus worker, Bus CLI, Partner capture, and Provider-leg sender tests pass.

## Done summary
Extended the Agent Bus synchronous publish acknowledgement with an optional recipient_activity snapshot (status/reason/observed_at) sampled once from the recipient's canonical Harness activity immediately before fanout, attached only on delivered outcomes; the shared decoder and every caller (CLI, Partner capture, Provider-leg notices) stay additive-compatible and the CLI adds a conservative send-time suffix only when a valid snapshot is present.
## Evidence
