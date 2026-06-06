## Description

**Size:** S
**Files:** scripts/backstop-stats.ts (new), README.md, CLAUDE.md, test/backstop-stats.test.ts (new)

The before/after metric surface + documentation. Reads the sidecar and
reports per-backstop rescue count, rescue RATE (using the rollup
denominator), and staleness percentiles — the artifact that proves a
future fix worked.

### Approach

`scripts/backstop-stats.ts` mirroring `scripts/srv-ts-stats.ts`: read
`resolveBackstopLogPath()`, parse NDJSON tolerating a partial final line,
fold rescue records + rollup records into per-(backstop,class) {fires,
rescues, rate, staleness p50/p95/p99}, print a table. Update README
## Architecture + the sidecar/env file-map (add backstop.ndjson +
KEEPER_BACKSTOP_LOG alongside hook-drops/dead-letters/readiness-diagnostics)
and generalize the plan-worker-specific heartbeat ALARM prose into the
unified-channel description. Update CLAUDE.md: add KEEPER_BACKSTOP_LOG to
the test-isolation rule's path list, and add a one-line worker-contract
note that every worker emits a uniform backstop record on ceiling/heartbeat
rescue.

### Investigation targets

**Required** (read before coding):
- scripts/srv-ts-stats.ts — the log-aggregation script template (arg parsing, percentile math, table output).
- src/backstop-telemetry.ts (from `.1`) — record/rollup schema to parse.
- README.md ~426-448 (KEEPER_DROP_LOG/sidecar file-map cluster), ~1028-1043 (plan-worker heartbeat ALARM prose).
- CLAUDE.md ~93-101 (test-isolation rule) and ~326-350 (worker contract).

### Risks

- Rate math depends on the rollup denominator landing in the sidecar (from `.1`); if rollups are absent the script must degrade gracefully (report counts, mark rate as "n/a (no denominator)") rather than divide by zero.
- Docs must not overstate: this is observability-only — keep the "no behavior change / not a projection / never read by the reducer" framing explicit.

### Test notes

Feed the script a synthetic NDJSON fixture (rescues + rollups + a partial
final line) and assert the computed counts/rate/percentiles and
partial-line tolerance.

## Acceptance

- [ ] `scripts/backstop-stats.ts` reports per-(backstop,class) rescue count, rescue rate (from rollups), and staleness p50/p95/p99; tolerates a partial final line; degrades gracefully without rollups.
- [ ] README ## Architecture + sidecar/env file-map updated (backstop.ndjson + KEEPER_BACKSTOP_LOG); plan-worker-specific ALARM prose generalized to the unified channel.
- [ ] CLAUDE.md test-isolation rule lists KEEPER_BACKSTOP_LOG; worker-contract note added.
- [ ] Script has a fixture-driven test; `bun test` green.

## Done summary

## Evidence
