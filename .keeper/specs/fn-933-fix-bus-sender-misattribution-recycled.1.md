## Description

**Size:** S
**Files:** src/bus-worker.ts, test/bus-worker.test.ts, README.md, CLAUDE.md

### Approach

Add a recycled-pid guard to `enrichPeerFromJobs` (src/bus-worker.ts:472) so it
keys on `(pid, start_time)` instead of pid alone. Keep the existing pid query, and
ONLY when it finds a row, probe the live process's start_time via
`readOsStartTime(pid)` (src/seed-sweep.ts:101) ONCE and compare verbatim to the
row's `start_time`; on mismatch OR a null/failed probe, return null. `resolveHarnessIdentity`
(src/bus-worker.ts:536) already treats a null lookup as "keep climbing," so a null
return makes the ancestry walk continue to the true parent agent — that IS the
fail-closed behavior. Probe at most once per matched row, NEVER per ancestry hop.
Thread an injectable `readStartTime` probe (default the real `readOsStartTime`)
through `enrichPeerFromJobs` and the `opRegister` lambda (src/bus-worker.ts:805) so
the regression test drives a synthetic probe with no real `ps`. Then fold the
`(pid, start_time)` guard into the README anti-spoof sentence (~:3137) and the
CLAUDE.md bus-invariant block (one sentence; no new paragraph, forward-facing only).

### Investigation targets

**Required** (read before coding):
- src/bus-worker.ts:472 — `enrichPeerFromJobs`, the pid-only query to guard
- src/bus-worker.ts:536 — `resolveHarnessIdentity`, climbs on a null lookup (the fail-closed seam)
- src/bus-worker.ts:792 — `opRegister`, the SINGLE registration path for BOTH send and watch; lambda at ~:805 is the injection seam
- src/seed-sweep.ts:101 — `readOsStartTime`, returns the platform-tagged string / null; reuse, do not reimplement
- src/exit-watcher.ts:266 — `selectDeadReprobeCandidates`, the recycled-pid clause model (note: it leaves-alone on null; the bus inverts to fail-closed-climb — intentional)
- src/bus-identity.ts:110 — `liveChannelForIdentity`, the existing `(pid, start_time)` match to stay consistent with
- test/bus-worker.test.ts:278 and :353 — existing `enrichPeerFromJobs` (freshMemDb + `seedJob`) and `resolveHarnessIdentity` (injected probes) test patterns to extend

**Optional** (reference as needed):
- plugins/keeper/plugin/hooks/events-writer.ts — the start_time scraper; confirm it emits the SAME format `readOsStartTime` reads (shared `splitArgsLstart`/`parseLinuxStarttime`)

### Risks

- Format drift between the hook's persisted `jobs.start_time` and `readOsStartTime` output would make the guard never match → every live agent degrades to floor (worse than the bug). The early proof point gates this.
- A `ps` probe per ancestry hop would re-introduce the host-starvation cost — probe ONLY on a row-hit.
- A transient probe failure degrades a real sender to floor/anonymous; accepted (never misattribute > occasionally-anonymous), and documented.

### Test notes

PURE, default-tier: `freshMemDb()` + `seedJob` with a STALE `start_time`, inject a
`readStartTime` returning a DIFFERENT (live) value → assert `enrichPeerFromJobs`
returns null and `resolveHarnessIdentity` climbs to the true parent. Add a matching
case (probe == row) that enriches successfully, and a null-probe case (fails
closed). Assert correct resolution for BOTH a send (`send_only:true`) and a watch
(`send_only:false`) registration, since one guard governs both. No real `ps` in the
default tier (fn-904) — any real-`ps` contract goes to `*.slow.test.ts` + the
allowlist. Run `bun run test:full` (worker + db + bus paths).

## Acceptance

- [ ] `enrichPeerFromJobs` keys on `(pid, start_time)`; a stale dead row whose start_time differs from the live process is NOT returned.
- [ ] A null/failed `readOsStartTime` probe makes enrichment return null (fail closed) → the ancestry walk climbs to the true parent; no unguarded pid-only identity is ever bound.
- [ ] start_time is probed at most once per matched row, not per ancestry hop.
- [ ] An injectable start_time probe is threaded through so the test is pure; a recycled-pid stale-row case is proven NOT to misattribute, for both send and watch registration.
- [ ] Early proof point confirmed: `jobs.start_time` and `readOsStartTime` share a byte-identical format (or the guard normalizes before comparing).
- [ ] README + CLAUDE.md bus notes reflect the `(pid, start_time)` enrich guard (folded into existing wording, forward-facing).
- [ ] `bun run test:full` green.

## Done summary

## Evidence
