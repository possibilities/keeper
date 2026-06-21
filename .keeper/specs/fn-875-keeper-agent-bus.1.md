## Description

**Size:** M
**Files:** src/bus-db.ts (new), src/bus-identity.ts (new), src/db.ts (add path resolvers), test/helpers/sandbox-env.ts, test/bus-db.test.ts (new), test/bus-identity.test.ts (new)

Foundation layer: the bus's own SQLite store and the two-layer name
resolution core. Pure, in-process unit-testable — no socket, no worker
yet. This is the keystone correctness surface (dead-name resolution).

### Approach

Add `resolveBusDbPath` (KEEPER_BUS_DB → ~/.local/state/keeper/bus.db) and
`resolveBusSockPath` (KEEPER_BUS_SOCK → bus.sock) in `src/db.ts`, mirroring
the existing `resolveDbPath`/`resolveSockPath` style. In `src/bus-db.ts`
open bus.db with `new Database(path)` + the REUSED `applyPragmas` + the
bus's OWN forward-only `PRAGMA user_version` migrate ladder (decoupled from
keeper SCHEMA_VERSION) — NEVER call keeper's `openDb`/`migrate` on bus.db.
Schema: `channels` keyed on `(pid, start_time)` + `messages` (append-only,
id autoincrement = monotonic cursor) per the epic Architecture. Provide the
registry upsert/load/reap-by-cursor + message-append/replay-from-cursor
helpers (sole-writer; the worker owns the writable connection).

In `src/bus-identity.ts` implement the two-layer resolver as PURE functions
over (a) the live channel set and (b) a read-only keeper.db handle: layer 1
live-channel match, layer 2 `jobs` membership via
`json_each(COALESCE(name_history,'[]'))` (the show-job.ts pattern), tiered
exact → prefix → substring(current title only). Define fail-soft semantics:
on miss return the raw target (deliver-by-live-registration if present, else
surface unknown); on ambiguity prefer a LIVE channel, else the newest job by
`updated_at`. Extend `sandboxEnv` to sandbox KEEPER_BUS_DB AND KEEPER_BUS_SOCK
(mirroring the existing six paths) so no bus test strands them at prod defaults.

### Investigation targets

**Required** (read before coding):
- src/db.ts:51 (resolveDbPath), :60 (resolveSockPath), :1412 (applyPragmas — reuse), :1720 (migrate — keeper-specific, do NOT call on bus.db), :617-651 (jobs columns: pid 622, start_time 629, title 626, name_history 642), :614 (idx_jobs_pid)
- cli/show-job.ts:155-175, :460 (json_each name_history membership + read-only keeper.db open — the resolution model)
- test/helpers/sandbox-env.ts:50-75 (the SIX hardcoded keeper paths to extend)
- test/helpers/template-db.ts:113 (freshMemDb), :146 (freshDbFile)

**Optional** (reference as needed):
- ~/code/arthack/apps/chatctl/chatctl/resolve.py (tiered resolution shape), db.py (table shape), identity.py (name_history overlay)
- src/resume-descriptor.ts:25-35 (title = newest name_history entry)

### Risks

- bus.db open/migrate failure or a schema-version-ahead bus.db (old binary): decide degrade-vs-fatal NOW (a corrupt bus.db must not wedge keeperd boot — prefer a loud, isolated failure of the bus worker only, surfaced in T2).
- name collision across history (a common name in many jobs' name_history): the ambiguity policy above must be deterministic and unit-tested.
- resume gap: a just-started agent's pid not yet in keeper.db jobs — resolution must fail-soft to the live registry (its current name arrives via its own register frame in T2), not error.

### Test notes

Unit-test resolution with `freshMemDb` seeding a synthetic `jobs` table
(pid/start_time/title/name_history) + an in-memory channel set: current-name
hit, former-name hit, prefix/substring tiers, miss → fail-soft, ambiguity →
live-preferred-then-newest, pid-reuse (same pid, different start_time).
Unit-test bus.db migrate idempotency + cursor monotonicity + replay-from-cursor.
Add the new test files to the fast tier.

## Acceptance

- [ ] `resolveBusDbPath`/`resolveBusSockPath` honor KEEPER_BUS_DB/KEEPER_BUS_SOCK, else default under ~/.local/state/keeper/
- [ ] bus.db opens with its OWN user_version ladder (keeper openDb/migrate never called on it); `applyPragmas` reused; re-open is idempotent
- [ ] `channels` is keyed on `(pid, start_time)`; `messages` is append-only with a monotonic id cursor + replay-from-cursor helper
- [ ] Two-layer resolver: current-name, former-name (name_history), pid, session_id, and prefix/substring tiers all resolve; miss is fail-soft; ambiguity prefers a live channel then newest job — all unit-tested
- [ ] `sandboxEnv` sandboxes KEEPER_BUS_DB and KEEPER_BUS_SOCK; the CLAUDE.md "ALL FIVE"→"ALL SIX" doc bump is left for the docs task
- [ ] New unit tests pass in the fast tier

## Done summary
Bus storage layer (src/bus-db.ts: own user_version ladder, channels keyed on (pid,start_time), append-only messages with monotonic cursor + replay) and pure two-layer name resolver (src/bus-identity.ts: jobs exact/prefix/substring tiers, dead-name via name_history, fail-soft to live registry); path resolvers + sandboxEnv extended. 25 unit tests in the fast tier.
## Evidence
