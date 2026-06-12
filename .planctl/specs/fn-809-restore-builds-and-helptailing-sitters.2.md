## Description

**Size:** M
**Files:** sitters/helptailing/watch.ts (new), test/helptailing-watch.test.ts (new), test/build-pin.test.ts, plist/arthack.babysitter.helptailing.watch.plist (new), agents/helptailing.md (new), tsconfig.json, package.json, README.md, CLAUDE.md

### Approach

Recover `babysitters/helptailing/watch.ts` from `git -C ~/code/keeper show '8f8da06e~1:babysitters/helptailing/watch.ts'` into sitters/helptailing/watch.ts, then convert to the vendored conventions: `openDb(path, {readonly, prepareStmts:false})` -> `openDbReadonly` (lib/keeper-compat.ts:397); `resolveDbPath`/`atomicWriteFile` from `../../lib/keeper-compat`; `babysitterStateDir` from `../../lib/state`. Delete the old local 4-arg `writeFollowup` (old file ~line 864 — it collides with the shared export) and rewire onto lib/followups.ts via a FOLLOWUP_CONFIG + liveWriteFollowup body, mirroring sitters/performance/watch.ts. Adopt the lib/schema-pin.ts gate: an unwhitelisted live `meta.schema_version` emits a visible schema-skew finding and skips the DB detectors (performance/gitpolice posture — the old silent swallow-and-exit-0 does not survive the port). Port the old test suite onto test/helpers/fixture-db.ts + the schema-v66 fixture with the full sandbox env discipline (all five KEEPER_* paths + BABYSITTER_STATE_DIR per-test tmpdir). Extend build-pin SITTER_MODULES + add a public-surface test. Add the watch plist (StartInterval 300, RunAtLoad, never KeepAlive, PATH parity) retargeted to ~/code/sitter, and agents/helptailing.md with name+description front-matter matching agents/gitpolice.md. Wire tsconfig include, lint glob, README roster/tests prose.

### Investigation targets

**Required** (read before coding):
- `git -C ~/code/keeper show '8f8da06e~1:babysitters/helptailing/watch.ts'` — whole file; openDb call ~line 1008, local writeFollowup ~line 864, frozen-baseline sidecar seed logic
- lib/schema-pin.ts — SUPPORTED_SCHEMA_VERSIONS / readSchemaVersion / detectSchemaSkew, and how sitters/performance/watch.ts wires the gate into scan/tick
- lib/followups.ts — FollowupConfig contract + writeFollowup signature
- test/helpers/fixture-db.ts — fixtureDbFile/openWritable seeding

**Optional** (reference as needed):
- agents/gitpolice.md — front-matter + producer-doc shape
- `git -C ~/code/keeper show '8f8da06e~1:plist/arthack.babysitter.helptailing.watch.plist'` — old schedule/env to retarget

### Risks

- The frozen-baseline sidecar seeds once from a fixed pre-2026-06-11 window; on a DB with no pre-boundary rows it could seed a degenerate baseline — read the seed logic and cover the empty-window case in tests.
- The shared writeFollowup signature differs from the old local one — a mechanical rename without rewiring the config body would compile against the wrong arity.

### Test notes

Ported suite green on the schema-v66 fixture; explicit test that an unwhitelisted schema version yields the schema-skew finding and no DB-detector findings; heartbeat stamped on every completed path including missing-DB.

## Acceptance

- [ ] sitters/helptailing/watch.ts supports table/--json/--tick and exits 0 on missing DB, locked DB, and schema skew
- [ ] schema-skew finding emitted + DB detectors skipped on unwhitelisted version, covered by a test
- [ ] old local writeFollowup gone; followups flow through lib/followups.ts with ledger-conformant keys/filenames
- [ ] bun test green including the ported helptailing suite; build-pin covers the new entrypoint; fence green
- [ ] plist, agents/helptailing.md, tsconfig/lint/README wiring landed

## Done summary
Restored the helptailing --agent-help trend sitter into sitters/helptailing/watch.ts, converted to vendored-lib conventions (openDbReadonly, lib/followups, lib/schema-pin gate). Ported the test suite onto the schema-v66 fixture with the five-KEEPER_*-path sandbox plus schema-skew + empty-window coverage; wired build-pin, the watch plist, agents/helptailing.md, and README/CLAUDE roster. bun test green (304), lint clean, fence green.
## Evidence
