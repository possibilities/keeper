## Description

**Size:** S
**Files:** src/daemon.ts, test/daemon.test.ts

### Approach

Separate the backfill candidate horizon from the crash-loop rate constant: the probe scans
ledger rows bounded by the ledger cap (or ~24h), while the crash-loop distress decision keeps
its own window untouched. Emit one bounded log line per boot with scanned/matched/marked
counts. The enrich-row mechanics (producer-side sidecar, never a fold) stay as they are.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:9823 — the compactRestartLedger(..., CRASH_LOOP_WINDOW_MS) candidate-set build to re-scope
- src/daemon.ts:310-314 — the constants/import surface

### Test notes

Deterministic ledger fixtures through the existing probe seam: a >30-min-runtime predecessor with a matching .ips fixture gets enriched; one without gets the no-report marker; counts land in the summary line.

## Acceptance

- [ ] a long-runtime predecessor is attributed or no-report-marked at successor boot
- [ ] the per-boot summary line carries scanned/matched/marked
- [ ] daemon gates green

## Done summary

## Evidence
