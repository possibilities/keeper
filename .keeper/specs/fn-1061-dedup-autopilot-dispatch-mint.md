## Overview

One logical dispatch attempt can currently produce up to N same-instant
`Dispatched` rows in the append-only events log (observed 4x and 15x within
0m): the mint is inserted unconditionally before the launch outcome is
known, the only refire guard is an in-memory 200s cooldown that is CLEARED
on pre-launch aborts, `pending_dispatches` is truncated on every boot, and
the durable ack promises INSERT durability but not the fold — so pre-launch
abort loops, restart storms, and the insert→fold gap all amplify one intent
into many rows. This epic adds a durable, producer-owned rate-limit gate at
the mint site so one logical dispatch = one durable record, without moving
the sacred mint-before-launch + durable-ack ordering and without touching
the append-only events contract.

## Quick commands

- `bun run test` — full gate incl. refold-equivalence + schema-version tests
- `sqlite3 ~/.local/state/keeper/keeper.db "SELECT session_id, COUNT(*) FROM events WHERE hook_event='Dispatched' AND ts > strftime('%s','now')-86400 GROUP BY session_id HAVING COUNT(*) > 1"` — post-land: same-key dup mints in the last day should be legitimate re-dispatches only, never same-instant bursts

## Acceptance

- [ ] A re-mint of the same `verb::id` dispatchKey within the gate window (60s) inserts NO event row, and the worker receives a distinct suppressed ack (never a hung ack, never a fake ok)
- [ ] The gate state survives daemon restarts and covers the insert→fold gap (checked in the same transaction as the insert, on the daemon main writable connection)
- [ ] Suppression does NOT clear the redispatch cooldown (re-stamps it), so no suppress→abort→clear→re-dispatch hot loop
- [ ] Human `retry_dispatch` still fast-paths: it clears the gate row along with failedKeys
- [ ] Legitimate re-dispatches (TTL-expired at 120s, cooldown-cadence retries at 200s+) pass the gate untouched
- [ ] Mint-before-launch + durable-ack ordering unchanged; every mint request still gets a reply on every path
- [ ] No constraint added to the events table (historical dup rows must not break migration); refold-equivalence and schema-version tests green
- [ ] README cooldown-clearing, EPHEMERAL-projections, and boots-EMPTY passages revised in place to match the new behavior

## Early proof point

Task that proves the approach: `.1` (the gate table + transactional check
suppresses a synthetic double-mint in tests without breaking any existing
autopilot/reducer test). If it fails: fall back to a
dispatch_never_bound-style per-key attempt-generation record instead of a
time window, and re-derive `.2`'s ack semantics against that.

## References

- src/autopilot-worker.ts:3414-3489 — confirmRunning + the authoritative crash-safety ordering comment (the contract this epic must not move)
- src/autopilot-worker.ts:3778-3813 — cooldown glue; the aborted-prelaunch clear is the in-lifetime amplifier
- src/daemon.ts:5141-5215 — handleDispatchedMint, the gate's home; :2631 the every-boot truncateEphemeralProjections; :5553-5593 the TTL sweep the eviction rides
- src/db.ts:1639 EPHEMERAL_PROJECTIONS; :3705-3715 rewind DELETE list; :1142-1146 dispatch_never_bound (durable per-key state precedent); :49 SCHEMA_VERSION
- Investigation (2026-07-02, sitter triage): bursts observed 6/23 (4x/0m) + 6/24 (15x/0m); worktree-rework commits 71bd03bf + 041c6502 removed likely triggers but not the path
- VERIFICATION CAVEAT: the observing sitter fleet reads raw Dispatched rows and pins keeper schema versions — the SCHEMA_VERSION bump here re-blinds it until `bun run repin-schema` lands in ~/code/sitter, so the confirmation channel goes dark until that repin (do not edit the sitter from this epic)

## Docs gaps

- **README.md**: revise in place — cooldown-clearing passage (~3446: which outcomes clear vs keep vs re-stamp), pending_dispatches EPHEMERAL sections (~2378, ~2879: gate table is durable and deliberately NOT ephemeral), boots-EMPTY claim (~3443: narrow the rationale to the in-memory map that remains ephemeral)
- **CLAUDE.md/AGENTS.md**: none — they defer dispatch detail to README

## Best practices

- **Deterministic idempotency key from stable semantic fields only:** the existing `verb::id` dispatchKey; no timestamps/nonces in the key or dedup silently defeats itself
- **Durable anti-storm state in the DB, not memory:** an in-memory cooldown is no cooldown under a restart storm [Kubebuilder: no critical state only in memory]
- **Atomic gate check + insert in one transaction:** SELECT-then-INSERT across transactions leaves the crash window open
- **Suppression must be a first-class outcome:** reusing an existing failure outcome whose side effect (cooldown clear) re-arms the loop is the classic self-defeating dedup
- **Time-box dedup state with explicit eviction:** gate rows age out via the existing sweep; document the window and its relation to the 120s TTL / 200s cooldown
