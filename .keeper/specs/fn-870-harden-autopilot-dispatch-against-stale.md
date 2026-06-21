## Overview

keeper's autopilot silently stopped dispatching ALL work after the v76→v79
cutover: a rewinding migration's full re-fold resurrected weeks-old phantom
`pending_dispatches` that consumed the global dispatch budget + per-root mutex.
Two structural bugs: (1) `pending_dispatches` — ephemeral in-flight
launch-window state — was replayed from full history instead of rebuilt from
current reality; (2) the TTL sweep can never expire a pending once it lands in
`dispatch_failures`. This epic makes `pending_dispatches` an ephemeral
(boot-rebuilt, never-replayed) projection, makes the TTL sweep + operator-clear
self-heal stuck rows, excludes stale rows from the dispatch budget, and adds an
operator clear path for the `approve` verb. Builds on fn-868's projection-class
taxonomy.

## Quick commands

- `bun run test:full`   # mandatory — db/daemon/reducer/autopilot paths
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT COUNT(*) FROM pending_dispatches"`   # 0 at a fresh boot
- `keeper autopilot retry approve::<id>`   # operator clear (after task .3)

## Acceptance

- [ ] A full re-fold over historical `Dispatched` events leaves `pending_dispatches` empty at serve (no resurrection); `dispatch_failures` + `dispatch_never_bound` re-fold byte-identically
- [ ] A pending that tripped the never-bound breaker still gets expired by the TTL sweep; an operator can clear an `approve` pending
- [ ] Stale (past-ceiling) pendings don't consume the dispatch budget/mutex
- [ ] No SCHEMA_VERSION bump; the byte-identical charter excludes only `pending_dispatches`; `bun run test:full` green

## Early proof point

Task `.1`'s resurrection regression test: seed historical `Dispatched` events, rewind + re-fold, assert `pending_dispatches` is empty at serve. If it fails: the boot-truncate / charter-exclude is incomplete — fix before the self-heal + budget layers build on it.

## References

- Root cause (this session): the v76 backup had 0 `pending_dispatches`; the v77-rewind re-fold produced 5 phantoms (dispatched June 6-8); all 5 were BLOCKED-by-`dispatch_failures`, so the TTL sweep (`src/daemon.ts:273`, `WHERE df.verb IS NULL`) never expired them; they occupied 4 roots → `budget = cap(4) − occupied = 0` → total dispatch starvation. A one-time manual `DELETE` of the 5 rows unblocked dispatch this session; this epic is the durable fix.
- Decisions (resolved in planning): mechanism = **boot-truncate-after-drain** (no schema bump; empty-at-boot is correct since the autopilot re-derives in-flight launches from live `jobs`/tmux panes); SCOPE = **only `pending_dispatches`** is ephemeral (`dispatch_failures` + `dispatch_never_bound` stay deterministic-replayed — genuinely re-fold-deterministic + sticky-failure durability is intentional); clear = **extend `retry_dispatch` to `approve`** (no new RPC); BUG3 budget exclusion uses a **2×TTL hard ceiling** to avoid any double-dispatch window.
- Pattern: fn-868 `LIVE_ONLY_PROJECTIONS` / `rewindLiveProjection` (`src/db.ts:1181/1217`); Marten "Live" projection lifecycle; Fowler Time-Bound Lease (TTL expiry must be unconditional on lessee/breaker state).

## Docs gaps

- **CLAUDE.md**: event-sourcing invariants / projection-class taxonomy — name `pending_dispatches` as the ephemeral (not-replayed) class; fix the stale "joins the re-fold wipe list, so re-fold stays byte-identical" note for it; keep the RPC five-surface list accurate (`retry_dispatch` widened, still five).
- **README.md `## Architecture`**: `pending_dispatches` paragraph (kill the byte-identical claim), dispatch budget/mutex prose, `keeper autopilot` CLI reference (`retry approve::`).

## Best practices

- TTL/lease expiry must be UNCONDITIONAL on breaker/failure state — a sweep with a status-exclusion clause is the "suppressed sweep" deadlock. [Fowler — Time-Bound Lease]
- Ephemeral runtime state is rebuilt from current reality at boot, never replayed from history. [Marten — Live projection lifecycle]
- Budget/occupancy predicates should exclude expired rows; reset the never-bound counter on BIND, not on success. [practice-scout]
