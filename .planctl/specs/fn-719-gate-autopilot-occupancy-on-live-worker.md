## Overview

The autopilot's mutex-occupancy/readiness decision ignores backgrounded
worker-launched monitors. When a work session backgrounds a test suite
(`pnpm test` via Bash `run_in_background`) and then yields its turn, the
Stop fold flips the job to `stopped`, the task collapses to approve-ready,
and the closer/approve dispatches WHILE the suite is still running — the
live fn-715.2 incident (approve dispatched ~7s after the work Stop whose
snapshot still listed a `running` test suite). Sub-agents already gate this
via `subagent_invocations` + the `sub-agent-running` verdict; monitors do
not, because `jobs.monitors` (schema v51 / fn-682) is a DISPLAY-ONLY
projection that `src/readiness.ts` never reads, and the embedded
`epics.tasks[].jobs[]` shape readiness operates on does not even carry it.

This epic carries a `has_live_worker_monitor` fact onto the embedded job
(provenance-filtered so `ambient` session-watchers like the chatctl bus
NEVER occupy — only `monitor`/`bash-bg` worker-launched kinds), then adds a
`monitor-running` (+ `monitor-stale`) readiness occupant verdict that holds
the per-epic and per-root mutex and is non-dispatchable
(`verbForVerdict → null`), with a lease/TTL staleness floor so a
stopped-but-abandoned session can't wedge a slot forever.

Depends on fn-718 for COORDINATION, not data: the occupancy filter keys on
the `kind` already present on `MonitorEntry` today, but fn-718 edits the
same `computeMonitors` / `src/reducer.ts` / `src/readiness.ts` seams, so
this epic rebases on top to avoid a three-file merge conflict.

## Quick commands

- `bun test test/reducer.test.ts test/readiness.test.ts test/autopilot-worker.test.ts test/schema-version.test.ts`
- Repro check: a done+approved task whose embedded work job carries a live `bash-bg` monitor must render `running:monitor-running`, NOT `completed`, and `verbForVerdict` must return `null` for it.

## Acceptance

- [ ] A live worker-launched monitor (`monitor`/`bash-bg`) on a task's embedded job keeps the task `running:monitor-running` and holds both the per-epic and per-root mutex; the closer/approve cannot dispatch (reproduces + fixes the fn-715.2 premature-collapse)
- [ ] `ambient` monitors (chatctl bus) NEVER occupy — a test pins that an ambient-only job stays dispatchable
- [ ] A stopped-but-abandoned session releases the slot via a lease/TTL floor (soft TTL → `monitor-stale` still-occupying; hard ceiling → release); terminal `ended`/`killed` already clears it for free
- [ ] Whitelist-only schema bump 58→59 (no new real column); `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` gains 59 the same commit; re-fold determinism preserved (byte-identical from-scratch re-fold)
- [ ] `verbForVerdict` returns `null` for `monitor-running`/`monitor-stale` (null-lock test); occupancy never leaks into a dispatch

## Early proof point

Task that proves the approach: task 1 (carry the fact onto the embedded
job). It proves the keystone — that a Stop-event monitor fact can ride the
embedded `tasks[].jobs[]` JSON cell via the `buildEmbeddedJob` carve-out
re-fold-deterministically (the fn-670 `last_commit_for_task_at` precedent).
If its re-fold test can't reproduce byte-identical rows, the whitelist-only
embedded-fact approach is wrong — fall back to either a real `jobs` column
or having the reconcile snapshot join the top-level `jobs.monitors` by
`job_id` at read time (no embedded projection, no schema bump), and task 2
reads that instead.

## References

- fn-682 — the v51 `jobs.monitors` display projection this consumes (`computeMonitors` `src/reducer.ts:7487-7539`, `MonitorEntry` `src/derivers.ts:269`, provenance map)
- fn-670 T2 — `last_commit_for_task_at`: the embedded-job-fact + OLD-element carve-out + whitelist-only schema-bump precedent this mirrors (`buildEmbeddedJob` `src/reducer.ts:4283-4312`)
- fn-638.1 / fn-638.4 — the sub-agent Stop gate + `sub-agent-running` / `sub-agent-stale` staleness split this parallels (`SUBAGENT_STALENESS_SEC` `src/readiness.ts:304`)
- fn-671 / fn-703 — mutex occupancy holding through administrative windows (correctness over throughput); the predicate-1 done+approved gate this extends (`src/readiness.ts:556-563`)
- fn-700 / fn-703 — the `verbForVerdict → null` non-dispatchable-occupant pattern (`src/autopilot-worker.ts:576`) + its pinned test
- fn-718 (epic dep, coordination) — also edits `computeMonitors` / `src/reducer.ts` / `src/readiness.ts`; rebase after it lands

## Best practices

- **Treat the monitor snapshot as a lease, not a heartbeat:** TTL keyed to the gap between agent turn-ends, NOT the test-suite's own runtime — a 2-hour suite still heartbeats once per turn-end, so calibrate to turn cadence × a 3–5x safety factor (Temporal's `HeartbeatTimeout` vs `StartToCloseTimeout` decomposition).
- **Two knobs, whichever fires first:** a soft TTL (→ `monitor-stale`, still occupying, visibility) and a hard ceiling (absolute max slot hold → release). A single long "to be safe" TTL becomes a dead resource lock.
- **Staleness is evaluated at read time, never folded:** the fold records the fact; readiness compares `now - <lease anchor>` with `now` caller-injected (the sanctioned re-fold-determinism exception). A `Date.now()` in the fold shifts projections on every cursor reset.
- **`occupying = (monitor present) AND (snapshot fresh)`** — don't collapse the freshness dimension into a single boolean, or an abandoned session leaks its slot.

## Docs gaps

- **CLAUDE.md** "The mutex occupancy definition" bullet (~L386): REVISE (not append) the occupant-set sentence to add `monitor-running` (+ the `monitor-stale` staleness analogue) to the running-verdict list, update the fn-reference heading, and mention `monitor-running` in the `verbForVerdict`-returns-null callout.
- **README.md** `## Architecture` schema narrative (~L1376): add an `As of schema v59 (fn-N), ...` paragraph (embedded monitor fact, `monitor-running` fold, staleness floor, keeper-py whitelist add) and revise the v51 paragraph's "display-only" implication.
- **keeper/api.py** `SUPPORTED_SCHEMA_VERSIONS` (~L211): mechanical +59, enforced by `test/schema-version.test.ts`.
