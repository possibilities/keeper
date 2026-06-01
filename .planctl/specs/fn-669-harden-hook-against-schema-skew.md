## Overview

A schema bump that adds an `events` column the hook writes creates a
total-drop window: the hook (`plugin/hooks/events-writer.ts`, fresh
per-invocation, latest committed code) INSERTs the new column, but the
running daemon (sole migrator, hook opens `{migrate:false}`) hasn't applied
the migration yet, so the live DB lacks it — every hook INSERT fails its
eager `db.prepare()` ("no such column") and dead-letters until keeperd is
bounced. This bit us on 2026-06-01 (fn-668 v48 backend_exec columns, ~78
drops, whole feed down — see findings.md "SEV: schema-bump deploy skew").
Fix: make the hook column-adaptive — `PRAGMA table_info('events')` once per
invocation, build the INSERT from `known ∩ live` columns, so a
not-yet-migrated column is simply omitted (lands NULL after migrate, same as
today) and the INSERT SUCCEEDS instead of total-dropping. Turns a total-drop
window into a lossless-degraded one. Genuine failures (missing `events`
table, corrupt DB, real lock exhaustion) still dead-letter + exit 0.

## Quick commands

- `bun test test/events-writer.test.ts` — incl. the new skew-simulation + negative tests
- simulate skew: build an events table missing a known column → fire the hook → assert exit 0, row landed, NO dead-letter file

## Acceptance

- [ ] The hook builds its `events` INSERT from `known-columns ∩ live-columns` (via `PRAGMA table_info`), so a column the live DB lacks is omitted and the INSERT succeeds (lossless-degraded), not dead-lettered
- [ ] Genuine failures preserved: missing `events` table / corrupt DB / real BUSY exhaustion STILL dead-letter and exit 0 (the degrade only covers known-missing columns)
- [ ] A skew-simulation test proves degrade-and-succeed; a negative test proves a genuinely-broken DB still dead-letters
- [ ] Stays within hook constraints: no third-party deps, always exit 0, one `PRAGMA table_info` per invocation (cold-start budget); a stderr line names dropped columns for observability
- [ ] The daemon's shared `insertEvent` mint path is unaffected (adaptive build is hook-local, or proven identity on a migrated DB)

## Early proof point

Task `.1` Phase 1 (column-intersection build + the skew-sim test on a
hand-built old-schema DB) proves the degrade before touching the shared
statement seam. If the intersection is awkward at the shared `prepareStmts`
layer, keep it hook-local.

## References

- Incident: `~/docs/keeper-reliability/findings.md` ("SEV: schema-bump deploy skew", 2026-06-01)
- Static INSERT that prepares eagerly: `src/db.ts` `prepareStmts().insertEvent` (~:4750-4783) — SHARED with daemon synthetic-mint sites (`src/daemon.ts` ~:981,1057,1166,1224,1280,1413), so the adaptive build is hook-local
- Hook INSERT + bindings + dead-letter carve-out: `plugin/hooks/events-writer.ts` (~:593-630 bindings incl. the v48 backend_exec keys ~:627-629; ~:703-773 openDb/run/retry; ~:732-734 the "no such column → non-retriable → dead-letter" classification the degrade must intercept BEFORE)
- Canonical live-column probe to mirror: `addColumnIfMissing` (`src/db.ts:1432-1445`, `PRAGMA table_info`); note GENERATED cols need `table_xinfo` (none today)
- Two divergent `CREATE_EVENTS` literals (`src/db.ts:353-389` vs ~:642-646) — verify which is authoritative before deriving a column list
- Test harness: `test/events-writer.test.ts` (`sandboxedBaseEnv()` MANDATORY; `fireViaLauncher`; readback + `parseDeadLetterLine`)
- `fn-668-backend-exec-coordinates-on-jobs` (hard dep + overlap): its Task T3 (todo) rewrites the SAME INSERT block to populate backend_exec — land it first, build the adaptive INSERT on the final hook shape

## Best practices

- **Intersect-then-build, not try-full-then-fallback** — the failure is at `db.prepare()` (statement compile), before any bind, so catching + re-preparing is awkward; build the INSERT from the live column set up front.
- **One `PRAGMA table_info` per invocation, cached as a Set** — sqlite_schema is page 1 (warm in the daemon's open WAL), microseconds; well within the ~30ms cold-start.
- **Name every column explicitly** (never positional VALUES) — preserves the existing `$col` named-binding convention; omit keys, never reorder.
- **Observability without failing the write:** stderr-warn the dropped column names so the skew window is greppable in `claude --debug` / the drop-log.
- **Expand-before-write discipline** (migrator side): the daemon ALTERs the column in before code populates it; the adaptive INSERT is the safety net for the deploy race, and new columns must stay NULL-tolerant in the fold (they already are — NULL = zero-event value).

## Docs gaps

- **CLAUDE.md**: the "Migrations are forward-only / hook opens {migrate:false}" bullet gains one sentence (hook tolerates a behind schema via `PRAGMA table_info` intersection); the "hook always exits 0 / dead-letter" bullet gains one clause (a column-narrowed INSERT is a SUCCESS path, not a dead-letter).
- **README.md**: the hook-bootstrap narrative (~:348-358) — replace the binary "INSERT fails → dead-letter" with the two-level degrade (no DB → dead-letter; DB behind a column → narrowed-but-successful INSERT).

## Steward follow-up (NOT a planctl task)

Optional deploy-ordering belt: a host-local helper that bounces keeperd when
committed `SCHEMA_VERSION` > the running daemon's `meta.schema_version`
(shrinks the skew window proactively). Host-local, sibling to
dropwatch/orphanwatch — the steward sets it up if wanted; the hook-adaptive
fix already makes the window lossless, so this is belt-and-suspenders.
