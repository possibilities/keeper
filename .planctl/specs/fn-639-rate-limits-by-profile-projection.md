## Overview

A new top-level `profiles` projection, keyed by `config_dir`, correlates the
last `rate_limit` error with each Claude profile and surfaces it as a "Rate
limits by profile" block below the existing usage stacks in `scripts/usage.ts`.
This is the intermediate step toward weaving rate-limit state into the usage
surface — deferred for now because the agentuse profile id (e.g. `claude-multi-3`)
is not joinable to the config dir (e.g. `~/.claude-profiles/multi-claude-3`).
Scope is locked to `rate_limit` only; other `ApiErrorKind` values are handled
elsewhere and out of scope here.

## Quick commands

- `bun test test/reducer.test.ts test/collections.test.ts test/db.test.ts` — projection, descriptor, migration coverage
- `sqlite3 "$(bun -e 'console.log(require("./src/db").resolveDbPath?.()||"")')" 'SELECT * FROM profiles;'` — inspect the projection (or point at the live DB path)
- `bun scripts/usage.ts` — observe the new "Rate limits by profile" block below the usage stacks

## Acceptance

- [ ] The `profiles` projection rebuilds byte-identically on a from-scratch re-fold (rewind cursor, `DELETE FROM profiles`, re-drain → identical rows)
- [ ] Every unique `config_dir` gets a row on SessionStart (default `~/.claude` collapses to the `''` sentinel); a `rate_limit` stamps `last_rate_limit_at` + `last_rate_limit_session_id`
- [ ] `scripts/usage.ts` renders a "Rate limits by profile" block below the usage stacks, one row per profile, with a relative reset/error time or `—`

## Early proof point

Task that proves the approach: `.1`. If it fails: the fan-out isn't a pure function of the event log (most likely the in-transaction `jobs.config_dir` read or the seed stamping) — fix per the `syncIfPlanRef` read-then-write precedent and re-run the re-fold determinism test.

## References

- `src/reducer.ts` `syncIfPlanRef` (~:2714-2738) — canonical in-transaction read-then-write pattern to mirror for the `config_dir` read
- `src/db.ts` `CREATE_USAGE` (~:578) and `src/collections.ts` `USAGE_DESCRIPTOR` (~:364) — closest analogs for the new table + descriptor
- `fn-637` (overlap) — fn-637.2 also bumps the schema and fn-637.3 rewrites an adjacent `src/reducer.ts` region; this epic depends on fn-637 and targets the next free `SCHEMA_VERSION` (v34, since fn-637.2 claims v33 — verify at impl time)
- Locked design notes: `config_dir TEXT NOT NULL PRIMARY KEY` with `COALESCE(config_dir,'')` in both fan-outs (SQLite treats multiple NULL PK rows as distinct, so a nullable PK would not dedupe)

## Docs gaps

- **CLAUDE.md / AGENTS.md**: thread both new fan-outs into the "Cursor + projection advance in the SAME `BEGIN IMMEDIATE`" enumeration inline (don't append); add the `schema-vNN (fn-...)` citation
- **README.md**: collections paragraph (five→six collections, splice `profiles` after `usage`); Architecture schema-version trail (new `schema vNN` entry, worker count unchanged); Example clients `usage.ts` entry (now two subscriptions); Inspect section (new `profiles` sqlite3 snippet)
