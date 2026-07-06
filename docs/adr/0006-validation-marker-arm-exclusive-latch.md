# Validation marker is an arm-exclusive one-way latch

## Status

Accepted

## Context

An epic's `last_validated_at` marker doubles as autopilot's dispatch gate: readiness
blocks any epic whose marker is null (a "ghost"), and the gate ranks above the
dependency checks. An epic publish is multi-step (scaffold → assign-cells →
add-deps → validate), and every structural mutation verb in the plan tooling
re-stamped the marker after its post-write integrity check — including flipping a
ghost's null marker to a timestamp. That made every mutation verb a hidden arming
path: `assign-cells` armed an epic whose `depends_on_epics` was still empty, and
autopilot dispatched its task thirteen seconds before `add-deps` wired the
dependency. Guarding a single verb only moves the race — any interleaving in which
a re-stamping verb runs before dep-wiring re-opens it. Separately, the re-stamp's
"refresh" of an already-armed marker had no consumer (readiness and rendering test
only null-vs-set, never recency) while its read-then-write shape was a lost-update
vector against the concurrent arm and invalidate writers.

## Decision

The marker is a strict one-way latch with exactly three writer classes:

- **Arm (null → timestamp):** exclusively `validate --epic` / `armEpicValidated`,
  the trailing step every create/refine/defer/close flow already runs after deps
  are wired.
- **Un-arm (timestamp → null):** exclusively `epic invalidate` and
  `refine-context --invalidate`.
- **Everything else:** structural mutation verbs keep their post-write integrity
  gate (assert-all, fail-forward) but never read or write the marker.

The refresh branch is removed rather than made null-preserving: with no recency
consumer, refreshing was purely the clobber vector.

## Consequences

- An epic publish is dispatch-safe under any verb interleaving; a ghost stays
  blocked until the explicit trailing arm, so partially-published epics can never
  race the dispatcher.
- `last_validated_at` means "when the current validated state was established,"
  not "when an integrity check last passed"; structural edits to an armed epic do
  not move it. Re-establishing it goes through invalidate → validate.
- The gate verbs' machinery is named for what it does (post-write integrity
  gate), not for the removed stamping side effect.
