## Description

**Size:** M
**Files:** src/daemon.ts, src/restart-ledger.ts, src/server-worker.ts, test/daemon.test.ts, test/server-worker.test.ts, test/status.test.ts

### Approach

Extract the canonical restart-ledger contract into a dependency-free leaf shared by daemon and readers. After the single-instance lock and before DB open, append and sync one bounded boot record; failure is boot-fatal before Drain statistics or readiness. Remove normal-boot rewrite/aging: crash-loop window/cap remain read-side inputs, legacy conversion is explicit and lossless, malformed/unreadable history is never persisted as empty. Carry `{boot_id,pid,start_time}` plus Drain state onto every served result, including memoized steady state, and retain bounded exact fatal reasons only when evidence exists.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:4970-5459 — ledger constants, records, parsers, compaction, rewrite, and append paths
- src/daemon.ts:8191-8205 — current early boot-id mint
- src/daemon.ts:9788-9909 — late ledger write, Drain timing, and boot-complete ordering
- src/daemon.ts:15324-15352 — fatal enrichment behavior
- src/daemon.ts:15864-15883 — current signal-handler installation timing
- src/db.ts:5133-5147 — shared restart-ledger path resolver
- src/server-worker.ts:2422 and served result assembly nearby — steady-state result fields and omitted boot-header contract
- test/daemon.test.ts:2065-2590 — current parse, torn-tail, legacy, compaction, rewrite, and enrichment fixtures
- test/status.test.ts:193-389 — Drain observation served-frame fixtures

**Optional** (reference as needed):
- src/provider-leg-death-notice.ts:181-200 — bounded UTF-8 diagnostic precedent
- test/helpers/sandbox-env.ts:95-149 — required restart-ledger isolation

### Risks

- Writing before the single-instance lock would record rejected foreign boots; writing after DB/Drain repeats the evidence gap
- Appending to an unconverted legacy array corrupts both formats; migration must preserve every valid record exactly once
- Adding identity only to the transient boot header repeats the known memoized steady-state blind spot
- Requiring ledger durability can create a loud boot loop under ENOSPC; stderr and the existing launchd recovery posture must remain honest

### Test notes

Pin lock-before-append, append-before-DB/Drain, fsync/write failure fatality, true history retention across many old boots, torn-tail preservation, explicit legacy conversion, no empty rewrite after read failure, exact boot/enrichment linkage, bounded reasons, and steady-state served identity/Drain fields.

## Acceptance

- [ ] An admitted daemon durably appends one boot record after the single-instance lock and before DB open, migration, workers, Drain statistics, or socket readiness
- [ ] Boot-record persistence failure exits nonzero before healthy service; stderr names the bounded failure and no later stats/readiness publication occurs
- [ ] Normal boot never rewrites or ages forensic ledger history; valid prefixes survive torn/malformed tails, and legacy conversion preserves every valid record
- [ ] Crash-loop windowing and caps operate read-side without mutating the ledger, and exact boot-id enrichment remains append-only
- [ ] Every served result, including memoized steady state, exposes the same recycle-safe boot identity and current Drain state
- [ ] Focused daemon, server-worker, status, and typecheck gates pass

## Done summary
Extracted the restart-ledger contract into a dependency-free leaf; the daemon now durably appends and syncs one bounded boot record after the single-instance lock and before DB open, migration, workers, Drain, or readiness, exiting nonzero on persistence failure. Normal boot no longer rewrites/ages ledger history (crash-loop windowing is read-side only); legacy conversion is explicit and lossless, and torn/malformed tails preserve their valid prefix. Every served result, including memoized steady state, and the restart CLI's own reads now carry the same recycle-safe {boot_id,pid,start_time} identity plus current Drain state.
## Evidence
