## Description

From audit finding F1 against `src/bus-db.ts` (commit 32d9267b). At
`migrateBusDb` (line ~152), the loop
`for (const ddl of CREATE_CHANNELS_INDEXES) createIndexFailOpen(db, ddl)`
routes the channels index list through the fail-open helper. That list's
sole member is `CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_pid_start ON
channels(pid, start_time)` — the UNIQUE constraint backing the channels
upsert's `ON CONFLICT(pid, start_time)`. `createIndexFailOpen` is
documented as being for a pure query optimization (a partial-index
predicate an old SQLite rejects), and it swallows the error to
`console.error`; that rationale does not hold for a correctness constraint.
A swallowed UNIQUE-index create silently drops the `(pid, start_time)`
uniqueness invariant and leaves the daemon booting without the ON CONFLICT
target, so later channel upserts throw a cryptic "ON CONFLICT clause does
not match any PRIMARY KEY or UNIQUE constraint" at runtime instead of the
loud, isolated boot failure this file's own `migrateBusDb` doc calls for.

Fix: keep `CREATE_CHANNELS_INDEXES` on the strict `db.run(ddl)` (throwing)
path and apply `createIndexFailOpen` only to `CREATE_MESSAGES_INDEXES`
(both members — `idx_messages_ns_id`, `idx_messages_prune` — are
non-unique). The stated intent of the fail-open helper (degrade an
unsupported partial index) only ever required the messages block.

Files: `src/bus-db.ts`, `test/bus-db.test.ts`.

## Acceptance

- [ ] The channels UNIQUE index is created via strict `db.run` so a failed create throws (loud, isolated boot failure) rather than being swallowed.
- [ ] `createIndexFailOpen` still wraps the messages optimization indexes; a rejected messages-index DDL degrades without wedging migrate.
- [ ] A test asserts a failing channels UNIQUE-index create surfaces (throws), and a test asserts a rejected messages index degrades non-fatally and migrate still commits `user_version`.

## Done summary
Scoped createIndexFailOpen to the messages optimization indexes only; the channels UNIQUE index now runs on the strict throwing db.run path so a failed create surfaces loudly at boot. Added tests for both semantics.
## Evidence
