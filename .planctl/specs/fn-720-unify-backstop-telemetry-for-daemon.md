## Overview

Keeper has ~6 change-propagation paths (plan/git/transcript workers,
autopilot, pending-dispatch sweep, FSEvents-drop rescans). Each has a fast
path (data_version poll, post-fold kick, FSEvents) backed by a slow
"should-never-fire" heartbeat/ceiling fallback. When a fast path silently
drops a wake-up, the slow backstop rescues it — producing the operator's
30–60s stalls. Today those rescues are invisible (only the plan-worker has
an ALARM, fn-705.4), so every timeliness incident is debugged anecdotally
and there is no metric proving a fix worked.

This epic makes every backstop emit a UNIFORM structured record when it
fires, tagged with whether it actually RESCUED a missed fast path. Records
land in one append-only sidecar (`~/.local/state/keeper/backstop.ndjson`,
main = sole writer) plus an aggregation script that reports per-backstop
rescue COUNT, rescue RATE (rescues ÷ total fires — the denominator that
makes a before/after comparison honest), and staleness percentiles. This is
the FIRST piece of the larger timeliness effort; later epics FIX the
offenders this surfaces. It is OBSERVABILITY-ONLY: zero behavior change, no
new synthetic events, no schema/keeper-py bump, no reducer change.

## Quick commands

- `tail -f ~/.local/state/keeper/backstop.ndjson | jq .` — watch backstop fires live
- `grep '"rescued":true' ~/.local/state/keeper/backstop.ndjson | jq -c '{backstop,class,staleness_ms}'` — only the real rescues
- `bun run scripts/backstop-stats.ts` — per-backstop rescue count, rescue rate (uses the denominator rollups), staleness p50/p95/p99
- `bun test` — full suite green proves zero behavior change

## Acceptance

- [ ] Every backstop fires a uniform record: plan/git/transcript heartbeats, rescan FSEvents-drop recovery (class `missed-wake`); autopilot confirmRunning ceiling + pending-dispatch TTL sweep (class `timeout`).
- [ ] Record carries: `ts`, `kind:"backstop-rescue"`, `class` (missed-wake|timeout), `backstop`, `worker`, `fast_path` (null for timeout), `rescued` bool, `staleness_ms` (now−last_fast_path_at for missed-wake; elapsed-since-dispatch for timeout; nullable), `last_fast_path_at` (null for timeout/cold-boot), optional small `detail` (path/job_id/verb — NEVER raw payloads or plan content).
- [ ] Denominator present: in-memory `fires_total`/`rescues_total` per (backstop,class), flushed as periodic + on-shutdown rollup records, so `scripts/backstop-stats.ts` computes a true rescue RATE.
- [ ] Single sidecar, main is the SOLE writer (workers postMessage rescue/rollup records up); `KEEPER_BACKSTOP_LOG` env override resolves via the `src/db.ts` resolver pattern; `0600` perms; reader tolerates a partial final line.
- [ ] `KEEPER_BACKSTOP_LOG` added to EVERY spawn-test sandbox base-env (all duplicated `sandboxEnv` helpers) so tests never touch the real `~/.local/state/keeper/`.
- [ ] ZERO behavior change: no new synthetic events, no `SCHEMA_VERSION`/keeper-py bump, no reducer/fold change; existing fast-path trigger lines (db-poll/fswatcher non-rescue) keep their current low-key semantics; full `bun test` green.
- [ ] Loud human stderr ALARM stays for genuine heartbeat rescues but is rate-limited (per-key cooldown) so server.stderr can't flood — the NDJSON record + counters are NEVER rate-limited (the metric stays complete).
- [ ] README ## Architecture + sidecar/env file-map and CLAUDE.md (test-isolation rule + worker contract) updated to describe the generalized backstop channel.

## Early proof point

Task that proves the approach: `.1` (foundation). A unit test mints a
synthetic rescue record through the main-sole-writer path and asserts it
round-trips to the sidecar with the uniform schema. If it fails: the record
schema or the postMessage→main→sidecar topology is wrong — revisit before
wiring any worker. End-to-end validation lands in `.2` (first real heartbeat
rescue captured).

## References

- `src/plan-worker.ts:1380` — `logBackstopEmit` (fn-705.4): the existing severity-distinguishing reference template to generalize.
- `src/readiness-diagnostics.ts` — `appendDiagnostic`: canonical JSONL-sidecar writer (single appendFileSync, swallow-to-stderr, `{ts,kind,...}` envelope) to mirror.
- `scripts/srv-ts-stats.ts` — log-aggregation script template for the new `backstop-stats.ts`.
- epic-scout: all 143 keeper epics are `done`; zero open epics → no cross-epic deps.

## Architecture

Uniform record (NDJSON, one per line):

```jsonc
{
  "ts": 1748000004946,            // producer wall-clock epoch ms (legal: outside any fold)
  "kind": "backstop-rescue",      // stable envelope discriminator (readiness-diagnostics convention)
  "class": "missed-wake",         // | "timeout"
  "backstop": "git-heartbeat",    // plan-heartbeat|git-heartbeat|transcript-heartbeat|rescan-drop|autopilot-ceiling|pending-dispatch-sweep
  "worker": "git-worker",         // plan-worker|git-worker|transcript-worker|autopilot-worker|main
  "fast_path": "data_version_poll", // expected fast path; null for timeout class
  "rescued": true,                // false = backstop fired but nothing to rescue (the denominator)
  "staleness_ms": 61240,          // missed-wake: now-last_fast_path_at; timeout: elapsed-since-dispatch; nullable
  "last_fast_path_at": 1747999943706, // null for timeout class & cold boot
  "detail": {"path": "..."}       // optional, small; NO raw payloads/plan content
}
```

Topology: each worker maintains `last_fast_path_at` in-memory (stamped at
every confirmed fast-path fire) and in-memory counters `fires_total` /
`rescues_total` per (backstop,class). On a backstop fire the worker
`postMessage({kind:"backstop", record})`s up to main; main is the SOLE
writer of the sidecar (matches the sole-writer rule; avoids torn concurrent
appends). Volume control: a full record is written on every RESCUE; no-op
fires only bump the in-memory counter and are surfaced as a periodic +
on-shutdown ROLLUP record `{kind:"backstop-rollup", backstop, class,
fires_total, rescues_total}` so the denominator survives without a line per
5s no-op. The loud stderr ALARM is rate-limited; the NDJSON + counters are
not.

## Alternatives

- **Rescue-only (no denominator)** — rejected: survivorship bias makes the
  before/after stall metric uninterpretable (a fix is indistinguishable from
  the heartbeat firing less often). The denominator is the whole point.
- **Per-worker sidecar files** — rejected: simpler wiring but breaks the
  sole-writer norm and yields N files; chose one file + main-sole-writer.
- **Route through the event log as synthetic events** — forbidden:
  re-fold determinism (CLAUDE.md) bars a fold-driving fact from a telemetry
  line. Stays a pure producer-side side effect.
- **One NDJSON line per fire including no-ops** — rejected: plan heartbeat
  (5s) would write ~17k no-op lines/day. Counters+rollup instead.

## Rollout

Observability-only; ships dark with zero behavior change. No migration, no
schema bump. Validation = run the daemon, induce/observe backstop fires,
read the sidecar + `backstop-stats.ts`, confirm `bun test` green. Rollback =
revert; nothing persisted depends on the records (the sidecar is a pure
consumer-side side-file, never read by the reducer).
