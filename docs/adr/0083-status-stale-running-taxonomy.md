# 0083 — Status stale-running taxonomy

## Status

Accepted. Provisional number — fan-in renumbering per ADR 0020/0022.

## Context

A readiness verdict can remain `running` when its child or monitor evidence is
stale. This is deliberately conservative: stale evidence holds capacity but
cannot establish that work is currently active. Collapsing those rows into one
status count hides the distinction that the board pill already makes visible.

The status envelope also exposes `in_flight.running_jobs`, a broad count of
every working job. Maintenance-window callers need the narrower
`in_flight.board_work_jobs` count, which excludes the caller's session and
limits membership to Board-work dispatches. Existing external readers may still
rely on the broad field.

## Decision

Status tallies retain the `running` count for fresh running readiness verdicts
and add `stale_running` for `running:sub-agent-stale` and
`running:monitor-stale`. The split follows the readiness verdict reason, never
the rendered pill text. `total` remains the sum of every verdict category.

Each stale board view emits `last_evidence_at`, the most recent applicable child
or monitor freshness timestamp. This co-displays the evidence age anchor with
the stale pill rather than presenting cached evidence as a present-tense work
claim.

`in_flight.running_jobs` continues to emit unchanged and is docstring-deprecated
in favor of `in_flight.board_work_jobs`. Consumers can migrate without a wire
break; the two fields emit together.

## Consequences

- Status consumers can distinguish fresh work from conservative stale-running
  holds while preserving the existing total and envelope structure.
- Human and machine readers receive the evidence timestamp needed to interpret a
  stale board pill.
- Removing `running_jobs` is deferred until external consumers have had a
  migration window and an explicit compatibility review; no status-schema
  version authorizes its silent removal.
