## Description

**Size:** M
**Files:** src/usage-scrape-runner.ts, src/usage-scraper-worker.ts, src/usage-worker.ts, src/db.ts, src/reducer.ts, src/collections.ts, keeper/api.py, test/usage-scrape-runner.test.ts, test/usage-scraper-worker.test.ts, test/usage-worker.test.ts, test/schema-version.test.ts

### Approach

Add a keeper-side `UsageErrorKind` union using stable values: `format_changed`, `panel_missing`, `scrape_failed`, `upstream_limited`, and `runner_failed`. Teach `parseScrapeStdout` to accept the current schema and the new error-kind schema, preserving v1 behavior when the field is absent; `describeFailure` should use a provided kind first, classify runner failures as `runner_failed`, and fall back from error type/message/screen excerpt when needed. Add nullable `usage.error_kind` to the projection, bump the DB schema and keeper-py supported whitelist together, include the field in `USAGE_DESCRIPTOR`, and thread it through the usage-worker gate/seed path.

### Investigation targets

**Required** (read before coding):
- src/usage-scrape-runner.ts:91 — ScrapeResult shape and schema gate for the util JSON contract.
- src/usage-scraper-worker.ts:143 — Envelope error object currently carries type/message/at only.
- src/usage-scraper-worker.ts:1137 — failure normalization is the central place to assign keeper-side fallback kinds.
- src/usage-worker.ts:100 — UsageSnapshotMessage slot order and comments are load-bearing for projection shape.
- src/usage-worker.ts:451 — gate excludes only `error_at`; `error_kind` should remain gated so kind flips emit.
- src/db.ts:49 — schema version bump rule; update keeper/api.py in the same change.
- src/db.ts:996 — CREATE_USAGE needs the new nullable column in the zero-event shape.
- src/db.ts:5411 — append the new migration after the current latest block.
- src/reducer.ts:2830 — UsageSnapshotPayload parse and usage UPSERT need the new column.
- src/collections.ts:352 — usage descriptor must expose `error_kind` to subscribers.
- test/usage-scrape-runner.test.ts:122 — error-arm parsing coverage.
- test/usage-scraper-worker.test.ts:277 — failure envelope coverage.
- test/usage-worker.test.ts:299 — stale-error projection coverage.
- test/schema-version.test.ts:59 — schema whitelist guard.

**Optional** (reference as needed):
- README.md:2903 — usage-scraper producer architecture section.
- README.md:3784 — usage projection schema summary.

### Risks

Compatibility is the main risk: keeper must not reject the current agentusage contract while the Python util and keeper deploy at different times. The migration is additive and nullable, so re-folds should treat older events as `NULL` kind and preserve zero-event defaults.

### Test notes

Cover both a v2 error arm with explicit `error_kind` and a v1 error arm without it. Add a runner-failure test proving `runner_failed`, a parser-failure fallback proving `format_changed`, and a projection seed test proving `error_kind` participates in the gate while `error_at` remains excluded.

## Acceptance

- [ ] `ScrapeResult` carries `error_kind` on error arms and still parses current v1 error JSON.
- [ ] stale envelopes and `.error.json` sidecars include `error_kind` when known.
- [ ] `usage.error_kind` exists, folds from UsageSnapshot, seeds the usage-worker gate, and appears in usage subscription rows.
- [ ] DB schema version and keeper/api.py supported versions are updated together.
- [ ] Targeted usage/schema tests pass.

## Done summary
Added a stable usage error_kind classification: keeper parses error_kind off the v2 scrape contract (v1 falls back from the parser exception family), threads it through the scraper envelope/sidecar, the UsageSnapshot serializer/fold, the usage projection (schema v95 + keeper-py whitelist), and the subscription descriptor.
## Evidence
