## Description

**Size:** M
**Files:** src/daemon.ts, src/db.ts, test/daemon.test.ts, docs/adr/0003-fatal-exit-over-self-heal.md, CLAUDE.md

### Approach

Rewrite the restart ledger as append-only NDJSON keyed by boot_id, per ADR 0030. Boot appends
one line {boot_id, ts, provenance, prev_runtime evidence}; fatalExit appends one enrichment
line matched on boot_id (never timestamp — the current same-nowMs replace deletes overlapping
newer boots), and its ledger work becomes a single bounded appendFileSync that never blocks or
crashes the exit path. Compaction and window-aging happen ONLY at boot, in the process holding
the single-instance lock, via temp-file + fsync + rename; the reader tolerates a torn tail
(mirror src/dead-letter.ts parse discipline) and dual-reads the legacy JSON-array shape so the
crash-loop count survives the format flip. Provenance is captured once at the earliest boot
point from the XPC_SERVICE_NAME heuristic — tri-state launchd/unknown/foreign, missing or
garbage mapping to unknown — and frozen into the boot line; it is a forensic label, never an
enforcement input. Crash-loop counting becomes runtime-qualified at the producer: collapse
lines per boot_id, count a boot toward the distress threshold only when its predecessor died
young (a short runtime-before-death bound, mirroring launchd's throttle model), count unknown,
exclude foreign — while decideCrashLoop stays a pure timestamp counter with its signature
unchanged. Update CLAUDE.md's ledger clause in place and add the supersession pointer to ADR
0003's ledger mechanism section (its fatalExit-over-self-heal stance is unchanged).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:3693-3830 — the full ledger toolkit being reworked: parseRestartLedger (existing dual-read precedent), updateRestartLedger (the e.ts !== nowMs filter that erases overlapping boots), writeRestartLedger, boundRestartReason, caps and window constants
- src/daemon.ts:11635-11665 — fatalExit's ledger write (restartLedgerBootTsMs as nowMs) becoming the enrichment append
- src/daemon.ts:6890-6935 — the boot-fold append + decideCrashLoop producer + distress mint/clear the runtime qualification slots into
- src/dead-letter.ts:254-290 — the NDJSON single-writer / torn-tail contract to mirror
- test/daemon.test.ts:1179-1293 — decideCrashLoop + updateRestartLedger cases to reshape, including the same-nowMs enrich case the boot_id keying replaces

### Risks

- Double-count: boot line + enrichment line share a boot_id — the producer must collapse per boot_id before counting or one boot counts twice
- The runtime-qualification bound needs a defensible default (around two minutes); too long re-silences real loops, too short re-pages on CI bounces
- Legacy transition happens mid-incident: the dual-read must preserve existing entries as unknown-provenance lines, not drop them

### Test notes

Pure tests: NDJSON serialize/parse round-trip with torn tail, legacy-array dual-read, per-
boot_id collapse, runtime qualification (young-predecessor counts, healthy-predecessor bounce
does not, foreign excluded, unknown counted), compaction aging. decideCrashLoop's existing
matrix stays byte-identical — the producer changes, not the pure counter.

## Acceptance

- [ ] Overlapping boots each retain their ledger line and a dying boot enriches only its own line, proven by tests that fail against the timestamp-keyed behavior
- [ ] The reader survives a torn trailing line and dual-reads the legacy array shape preserving the count across the format transition
- [ ] A bounce of a healthy long-running daemon does not advance the crash-loop count; repeated young deaths do; foreign boots never count and all lines are retained for forensics
- [ ] fatalExit's ledger write is a single bounded append that cannot throw out of the exit path
- [ ] decideCrashLoop's public contract is unchanged and its existing tests pass unmodified
- [ ] CLAUDE.md's ledger clause and ADR 0003's supersession pointer are updated; lints stay green

## Done summary

## Evidence
