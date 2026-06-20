## Overview

The babysitters mechanism moves out of keeper into its own repo at
`~/code/sitter`: a zero-keeper-import Claude plugin + launchd daemon set that
observes keeper purely through durable contracts — read-only SQLite at a
whitelisted schema version, NDJSON telemetry files, and its own state tree
under `~/.local/state/babysitters/`. The sitter repo gains Bun scaffolding,
a vendored helper module (path resolvers, atomicWriteFile, parsePlanRef, a
local read-only DB opener, computeStats), a net-new schema-skew guard, its
own test suite seeded from a checked-in `schema.sql` contract fixture, and
the launchd jobs. Keeper loses the `babysitters/` tree and every reference
to it.

## Quick commands

- `cd ~/code/sitter && bun test` — full sitter suite
- `bun run ~/code/sitter/performance/watch.ts --json` — live scan against keeper.db
- `rg -l "code/keeper/src|\.\./src/" ~/code/sitter --glob '*.ts'` — zero-import fence (expect no hits)
- `launchctl print gui/$(id -u)/arthack.babysitter.performance.watch | head -20` — cutover health
- `claude --plugin-dir ~/code/sitter -p 'list available agents'` — plugin resolves

## Acceptance

- [ ] The performance sitter runs end-to-end from `~/code/sitter` (scan, tick, agent spawn, watchdog) with zero imports from keeper source
- [ ] An unknown `meta.schema_version` produces a `schema-skew` finding and skips DB-reading detectors instead of scanning blind
- [ ] launchd jobs run from sitter paths, cut over with no monitoring gap, and state under `~/.local/state/babysitters/performance/` carries over untouched
- [ ] keeper has no `babysitters` references left and `bun run test:full` is green

## Early proof point

Task that proves the approach: `.1` (scaffold + move + vendored opener
running against the live DB). If it fails: keep the vendored helper module,
pause the tree move, and rework the failing surface before continuing.

## References

- `fn-792` (dependency) — rewrites the performance sitter's escalation paths
  (followup-writer into `babysitters/lib/`); extraction must pick up the
  post-convergence `watch.ts`, not the pre-fn-792 one.
- `fn-790` (overlap) — builds sitter writes new files into the tree being
  moved; wired as a dep so it lands first (or gets retargeted to `~/code/sitter`).
- `fn-791` (overlap) — helptailing sitter writes the tree plus
  `commands/babysit-init.md`, both in this epic's move set; same ordering choice.
- Key source surfaces: `babysitters/performance/watch.ts` (scanner; spawn
  constants at 2289-2301, scan open at 1512-1523, Category union at 148-177),
  `src/db.ts` (resolvers 51/60/316/331/344, pragmas 1078-1089,
  atomicWriteFile 3607), `src/derivers.ts:306-340` (parsePlanRef),
  `scripts/backstop-stats.ts` + the four type aliases in
  `src/backstop-telemetry.ts`, `keeper/api.py:258` (whitelist model).

## Docs gaps

- **keeper README.md**: prune the babysitter Architecture (~2365-2406), Install (~452-505), and Uninstall (~1176-1183) blocks — replace with a one-line pointer to `~/code/sitter`
- **keeper CLAUDE.md**: drop the "Babysitters carve-out" bullet; move the "pure read-only external scanners" invariant to sitter's CLAUDE.md
- **sitter README.md**: create — what the daemon set is, launchd install/uninstall, the schema-fixture regen one-liner
- **sitter CLAUDE.md**: create — read-only-observer invariant, zero-keeper-import fence, whitelist-update rule

## Best practices

- **`PRAGMA query_only=ON` + `busy_timeout` on the read-only opener:** SQL-level belt over the readonly-open suspenders; absorbs WAL-recovery lock blips [sqlite.org]
- **Tolerant reader:** SELECT named columns only, fold unexpected types to safe defaults — never `SELECT *` [martinfowler.com/bliki/TolerantReader.html]
- **Schema fixture as consumer-driven contract:** the checked-in `schema.sql` failing against new expectations IS the "keeper changed the schema" signal; whitelist bumps are deliberate fixture-regen commits [grype-db / pact pattern]
- **launchd has no hot-swap:** bootstrap the new job before bootout of the old to avoid a no-monitor window [launchd.info]
- **Vendor, don't `file:`-depend:** a `file:` dep hard-couples filesystem layout and breaks CI; ~150 lines between exactly two repos is vendoring territory [htmx.org/essays/vendoring]
