# 4. Forward-only schema migrations

## Status

Accepted.

## Context

The projection schema evolves as keeper grows. A migration framework usually ships
paired up/down steps so a schema can roll backward. Down-migrations are rarely
exercised, easy to get subtly wrong, and dangerous against an append-only event
log: rolling a projection schema backward while the log keeps moving forward
invites a store that no version can fold cleanly.

## Decision

Migrations are forward-only, versioned through a single `schema_version` in the
database meta. The daemon is the sole migrator, runs pending steps in order on
boot, and never downgrades a database stored above the running binary's
`SCHEMA_VERSION`. Non-idempotent steps are guarded by their target version so a
re-run is a no-op. Because projections are derived, a schema change that needs a
different shape is expressed as a rewinding migration that wipes and re-folds the
deterministic projections from the event log — the events themselves are never
migrated.

When `SCHEMA_VERSION` is bumped, the new version is added to the supported
whitelist in the same change, enforced by test, so a binary always declares
exactly which stored versions it can open.

## Consequences

- There are no down-migrations to write, test, or trust; the only direction is
  forward, and a re-fold reconstructs any projection shape from the durable log.
- A newer database is never silently downgraded by an older binary — it refuses
  rather than corrupting, which the version whitelist makes explicit.
- Rollback of a release means shipping a forward step that restores prior
  behavior, not reversing the schema; this is more deliberate and less error-prone
  than a symmetric up/down pair.
- The event log is the durable substrate: migrations touch only the derived
  projections, so a schema mistake is recoverable by re-folding.
