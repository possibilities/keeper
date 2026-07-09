# 26. Retire the Python projection-reader package

## Status

Accepted.

## Context

Keeper carried a zero-dependency Python distribution that opened `keeper.db`
read-only and exposed a small set of projection queries. Its schema-version
whitelist duplicated every entry in the TypeScript migration ladder, so every
schema change paid a cross-language maintenance cost even when it touched none
of the columns Python read.

The only external source consumer is the sibling ArtHack workspace. It needs
four session-identity queries over stable `jobs` columns; the remaining readers
have no callers. These ArtHack call paths are narrow and scheduled to disappear,
so maintaining a general keeper-owned Python distribution is disproportionate.

## Decision

Keeper ships no Python package or Python projection API. ArtHack owns the four
read-only session queries it consumes and opens the database with SQLite
`mode=ro`, `query_only`, and a bounded busy timeout. The reader validates the
contract by executing its fixed-column queries: a missing database or
incompatible projection fails at the read boundary, with no global schema
version whitelist.

Keeper's schema migration machinery owns only the explicit `SCHEMA_STEPS`
ladder, its derived `SCHEMA_VERSION`, pinned test assertions, and
`SCHEMA_FINGERPRINT`. Merge-time renumbering updates those local surfaces only.

## Consequences

- Schema changes no longer require a synchronized edit in another language.
- ArtHack temporarily couples to `jobs.job_id`, `pid`, `cwd`, `title`,
  `name_history`, and `updated_at`; incompatible changes fail visibly there.
- New external consumers use keeper's CLI/socket read surface rather than
  introducing another language-specific package.
- Keeper's full test gate contains the root, plan, and prompt suites.
