## Description

**Size:** M
**Files:** src/backstop-telemetry.ts (new), src/db.ts, src/daemon.ts, test/backstop-telemetry.test.ts (new), test/session-state.test.ts, test/find-task-commit.test.ts, test/commit-work.test.ts

The keystone: the shared contract every later task wires into. Builds the
uniform record type, the sidecar writer (main sole-writer), the env-path
resolver, the in-memory counter/rollup mechanism, and makes the new path
sandbox-safe. No worker wiring yet — that is `.2`/`.3`.

### Approach

Add `src/backstop-telemetry.ts` exporting: the `BackstopRecord` /
`BackstopRollup` types (schema in the epic Architecture), a
`BackstopCounters` helper (per-(backstop,class) `fires_total`/`rescues_total`
with a `bump(rescued)` method), a rate-limiter (per-key cooldown token
bucket for the stderr ALARM only), and an `appendBackstopRecord(rec,
logPath)` writer mirroring `src/readiness-diagnostics.ts` `appendDiagnostic`
(single appendFileSync of `JSON.stringify(rec)+"\n"`, `mode:0o600`,
swallow-to-stderr, never throw). Add `resolveBackstopLogPath()` +
`KEEPER_BACKSTOP_LOG` to `src/db.ts` following the
`resolveDeadLetterDir`/`resolveDropLog` env-override→default pattern. In
`src/daemon.ts` add a `{kind:"backstop"}` worker→main message handler that
calls `appendBackstopRecord` (main = sole writer) and a shutdown-time
rollup flush. Add `KEEPER_BACKSTOP_LOG` to every spawn-test sandbox
base-env helper so tests never write the user's real state dir.

### Investigation targets

**Required** (read before coding):
- src/readiness-diagnostics.ts — the appendDiagnostic writer to mirror near-verbatim (envelope, swallow-to-stderr, per-call open).
- src/db.ts:69-110 — resolveDbPath/resolveSockPath/resolveDeadLetterDir/resolveDropLog env-override pattern; add resolveBackstopLogPath here.
- test/readiness-diagnostics.test.ts — sidecar-write test template (mkdtemp, append, read+assert one JSON line, round-trip parse).
- test/session-state.test.ts:51, test/find-task-commit.test.ts:52, test/commit-work.test.ts:64 — the three duplicated `sandboxEnv` helpers that must each gain KEEPER_BACKSTOP_LOG (CLAUDE.md test-isolation rule, lines ~93-101).
- plugin/hooks/events-writer.ts:544 — KEEPER_DROP_LOG / 0o600 append precedent.

**Optional** (reference as needed):
- src/dead-letter.ts — NDJSON parse-line (null on partial line) contract for the reader side used by the aggregation script in `.4`.

### Risks

- The 0600 + parent-dir-missing edge: `resolveBackstopLogPath` is pure (no I/O, per db.ts pattern); the writer must tolerate a missing parent (the DB dir normally already exists — assert, don't silently lose records).
- Counters must be decoupled from the rate-limited stderr line — a rate-limited ALARM must STILL bump the counter and STILL write the NDJSON rescue record, or the denominator breaks.

### Test notes

Unit-test the writer round-trip (the epic Early proof point), the counter
bump/rollup math, the rate-limiter (cooldown suppresses the Nth stderr line
but not the counter), and that `KEEPER_BACKSTOP_LOG` redirects the path.
Confirm a write failure is swallowed (no throw / no fatalExit).

## Acceptance

- [ ] `src/backstop-telemetry.ts` exports the record/rollup types, counters helper, rate-limiter, and `appendBackstopRecord` (0600, swallow-to-stderr, never throws).
- [ ] `resolveBackstopLogPath()` + `KEEPER_BACKSTOP_LOG` added to src/db.ts in the existing env-override→default style.
- [ ] main handles `{kind:"backstop"}` worker messages as the sole sidecar writer + flushes a rollup on shutdown.
- [ ] `KEEPER_BACKSTOP_LOG` added to all spawn-test sandbox base-env helpers; no test writes the real state dir.
- [ ] Early proof point: a synthetic rescue record round-trips to the sidecar through the main writer (unit test).
- [ ] `bun run lint` + `bun run typecheck` + new unit tests green; no schema/reducer/keeper-py change.

## Done summary
Built the backstop-telemetry foundation: src/backstop-telemetry.ts exports BackstopRecord/BackstopRollup types, BackstopCounters (fires/rescues per backstop,class), BackstopRateLimiter (per-key cooldown gating only the stderr ALARM), and appendBackstopRecord (0600 NDJSON, swallow-to-stderr, never throws). Added resolveBackstopLogPath/KEEPER_BACKSTOP_LOG to db.ts, main {kind:'backstop'} sole-writer handler + shutdown rollup flush in daemon.ts, the PlanWorkerOutbound union extension, and KEEPER_BACKSTOP_LOG in all five spawn-test sandbox helpers. Observability-only; no schema/reducer/keeper-py change. 17/17 new unit tests pass; lint+typecheck green.
## Evidence
