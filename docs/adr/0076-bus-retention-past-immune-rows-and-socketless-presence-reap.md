# 0076 — Bus retention advances past immune rows; presence ages out socketless

Status: Accepted (provisional number; renumber at fan-in)

## Context

Message retention reads only the front batch of the log by id and preserves
undelivered queued-for-wake rows regardless of age. A head block of immune
rows therefore parks all pruning while the log grows unboundedly behind it —
and the immune set is unbounded by design (an escalation queued for an
offline planner survives until that planner returns, which may be never).
Any scan whose per-tick cost tracks the immune-prefix length re-imports the
serve-loop stall class the bus-degrade decision (ADR 0059) exists to
prevent, just via the SELECT instead of the DELETE.

Channel presence rows are pruned by identity probes, but a live pid whose
start-time cannot be read (foreign owner, zombie, parse miss) is kept
forever under the fail-safe keep — unverifiable-forever rows accumulate
without bound. The glossary defines Presence as holding an open watch
subscription, not as process liveness.

ADR 0048 recorded retention as a single bounded front-window decision; this
record supersedes that scan shape only — the retention horizons and the
row-first artifact coupling stand.

## Decision

- **Retention deletes eligible rows through the immune set.** An eligible
  row is aged past its horizon and not an undelivered queued-for-wake row.
  The scan is served by a partial index that excludes queued-for-wake rows,
  so per-tick cost is O(batch) regardless of immune-prefix size; the batch
  bound counts eligible rows (predictable drain); the returned artifact-id
  set remains exactly the deleted set, preserving the row-first artifact GC.
  A row that flips off queued-for-wake enters the partial index on that
  UPDATE and ages out through the ordinary re-evaluated scan — no watermark
  cursor exists to strand it.
- **Undelivered queued-for-wake rows keep NO escape valve.** Unbounded
  immune growth is the accepted price of wake-queue durability; bounding it
  would silently drop a queued escalation.
- **Control-namespace pruning shares the same scan shape** as
  defense-in-depth, although control rows are never immune today.
- **The partial index lands in the unconditional create-if-missing block** —
  no bus schema version bump; an older binary keeps working against the
  same file.
- **Presence follows its definition.** A channel row with no live socket
  past a generous age horizon is reaped even when its pid identity cannot
  be verified; the fail-safe keep applies only inside the horizon. A row
  with a live socket is never reaped.
