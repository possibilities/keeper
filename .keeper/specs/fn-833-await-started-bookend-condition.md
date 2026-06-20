## Overview

Add a `started <id>` condition to `keeper await` — the missing "start
work" bookend, symmetric across epics and tasks, pairing with the
existing `complete` end-bookend so a session can block until an item
BEGINS being worked, then run a follow-up. Keyed on a monotonic,
determinism-safe "work has begun at least once" predicate
(job-presence OR runtime_status in {in_progress, done} OR
worker_phase=done) — deliberately NOT the liveness `running` verdict,
which flaps between turns and is reconnect-sensitive. Reuses the
existing planctl slot machinery (presence tracking, scope-exempt
re-query, reconnect-blip gate); read-only — no RPC, no schema, no
migration.

## Quick commands

- `keeper await --help | grep -A1 started` — HELP lists the new condition.
- `keeper await started fn-N-slug.M` — wait for a task to start, exit met.
- `keeper await started fn-N-slug` — epic variant.
- `bun run test:full 2>&1 | grep -Ei "await|started"` — slow-tier await suites pass.

## Acceptance

- [ ] `keeper await started <id>` fires `met` for an epic or task once
      work has begun (job-presence, runtime_status in {in_progress,
      done}, or worker_phase=done).
- [ ] An already-started target at arm time emits `armed` then immediate
      `met` (no refuse-upfront).
- [ ] The missed-start-edge is a non-issue: a task that starts AND
      finishes between two polls still fires `met` off the post-completion
      snapshot.
- [ ] A `started` wait on a target that finished and popped off the board
      fires `met`, not `deleted` (absentBranch extension).
- [ ] The readiness `running` verdict is NOT used as the keying signal;
      the predicate is pure (no Date.now/env/fs).
- [ ] `bun run test:full` passes.

## Early proof point

The whole feature is one task; the proof is the pure-predicate
truth-table in `test/await-conditions.test.ts` evaluating `started`
against `computeReadiness` fixtures, plus the popped-off-board `met`
case. If the absentBranch / popped-off case yields `deleted` instead of
`met`, fix the `condition === "started"` arm in `absentBranch` before
wiring the runner.

## References

- `src/readiness.ts:1285` — `epicWorkStarted`, the monotonic sticky
  job-presence predicate to MIRROR. Compose with the full task-started
  predicate; do NOT import it (unexported, and it only checks
  `jobs.length`).
- `src/await-conditions.ts:447,484,519` — `evaluateTaskAwait` /
  `evaluateEpicAwait` / `absentBranch` (the extension site).
- `cli/await.ts:229,705,741` — `PLANCTL_CONDITIONS` set plus the TWO
  literal-union edit sites (`hasPlanctl` stream selection at 705, slot
  construction at 741). Missing 705 makes `started` hang at `armed`.
- Prior art: `kubectl wait` (level-triggered, re-checks stored
  conditions) and systemd `network-online.target` (monotonic-milestone
  naming) — `started`, not `running`.
- `README.md:1066-1122` and `plugins/keeper/skills/await/SKILL.md` —
  user / agent-facing condition docs to extend.
