# 20. Schema-version collisions renumber at merge time

## Status

Accepted. Partially superseded by ADR 0022 (explicit-version schema step
ladder): the hand-renumber mechanism this record describes now operates over
`SCHEMA_STEPS` instead of an interleaved guard block. This record's
provisional-numbering and trunk-keeps-its-numbers rule still governs a fan-in
collision.

## Context

Migrations are forward-only through a serial integer `SCHEMA_VERSION` (ADR 0004),
and the autopilot develops several epics concurrently on worktree lanes cut from
main. Each lane that adds a migration reads main and claims "the next" number at
authoring time, so two migration-bearing lanes in flight are guaranteed to claim
the same integer — the constant is a shared counter with no allocator.

The failure is partly silent. The migration-ladder blocks conflict textually at
fan-in, but when both sides write the identical next number, git treats the
`SCHEMA_VERSION` line and the `SUPPORTED_SCHEMA_VERSIONS` whitelist line as
agreement and merges them clean: two different schemas sharing one version
number, with no conflict marker on the lines that matter. Composing both
migrations under the shared number is not an option — a database that already
reached that number via one lane skips the other lane's version-guarded step
forever, and a rewinding step fused with an unrelated additive step under one
guard is unauditable.

Alternatives considered: timestamp or content-addressed migration ids
(Rails/Django/Alembic style) remove the collision but break the
`preMigrateStoredVersion < N` guard model — a higher stored scalar silently
skips a lower-numbered guard — and would require an applied-migrations table, a
substrate change out of proportion to the problem. Serializing every
migration-bearing epic behind a dependency edge prevents the collision but
throttles planning throughput and cannot be enforced for epics planned in the
same session (the epic scout cannot see siblings it just scaffolded).

## Decision

A lane's migration number is provisional until landed. Landing order into main
is the true order:

- Trunk keeps its landed numbers, always. A landed migration is deployed
  reality and is never renumbered.
- The unlanded lane renumbers to main-tip `SCHEMA_VERSION` + 1, read at merge
  time and re-verified immediately before the merge commit. The version
  whitelist entry, the pinned schema-version test assertions, and the version
  narrative comments move with it in the same commit.
- The silent surface is made loud by `SCHEMA_FINGERPRINT` (src/db.ts): a pinned,
  version-prefixed hash of the fully-migrated schema shape, recomputed by a pure
  test. Every schema change re-pins the one line, so two concurrent schema edits
  always produce a real git conflict on it — the schema is a singleton resource
  and the fingerprint line is its lock file.
- A merge resolver may apply the renumber mechanically when every colliding
  step is provably additive-idempotent (bare `addColumnIfMissing`-class steps).
  It stays BLOCKED for a human on anything version-guarded, rewinding, or
  CREATE-literal-changing — the set where a shared number corrupts.

## Consequences

- Concurrent migration-bearing epics stay plannable in parallel; the collision
  resolves at the one point where total order exists (the fan-in), by rule
  instead of ad-hoc judgment.
- The fingerprint taxes every concurrent schema edit with one deliberate
  conflict, including pairs that would compose fine — accepted, since any
  concurrent schema edit deserves merge-time attention.
- Renumbering at merge means a lane's spec and commits may reference a version
  number that shifts at landing; specs should treat the number as "assigned at
  merge" rather than a fixed identifier.
- A structural follow-up (deriving the version from an ordered step registry,
  and generating the whitelist from it) can retire the hand-renumber entirely;
  this record governs until that lands.
