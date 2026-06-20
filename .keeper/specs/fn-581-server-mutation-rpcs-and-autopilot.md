## Overview

The keeper daemon's read-only NDJSON-over-UDS subscribe socket gets its first
mutation path: a new `rpc` frame type the server dispatches to handlers that
write the DB through a server-worker-owned writer connection. The first
concrete RPC is `set_approval`, backing a per-task approval system
(pending/approved/rejected) surfaced as a pill in the autopilot client's
redesigned epic-block view. A new `approvals` sidecar table (schema v11)
holds the state; it is NOT a reducer projection — the event-log re-fold
determinism guarantee does not touch it. The autopilot client subscribes to
both `epics` and `approvals` via two simultaneous `Bun.connect` sockets (the
server's one-subscription-per-connection contract is unchanged), composing a
frame that shows newest-first epic blocks with slugs only, a virtual
`close:<epic_id>` row per epic, and an `[approved]` / `[rejected]` /
`[pending]` pill per row. A new `bun scripts/approve.ts <epic_id> <task_key>
approve|reject|clear` CLI is the first concrete RPC client.

This is the first of an expected larger surface of RPCs; the protocol shape,
the server-worker writer-connection lifecycle, the dispatch registry, and
the error taxonomy are deliberately built as a generic foundation, not
welded to the approvals feature.

## Quick commands

- `bun keeperd` — run the daemon
- `bun scripts/autopilot.ts` — live epic-block view with approval pills
- `bun scripts/approve.ts <epic_id> <task_id> approve` — approve one task
- `bun scripts/approve.ts <epic_id> close:<epic_id> approve` — approve close
- `bun test` — full test suite

## Acceptance

- [ ] Protocol carries `rpc` request frames and `rpc_result` response frames; both ends round-trip through `LineBuffer`
- [ ] Server-worker holds a dedicated writer connection alongside its reader; an RPC dispatch registry maps method names to handlers
- [ ] Schema v11 lands the `approvals` table (`approval_id` real pk, `UNIQUE(epic_id, task_key)`, CHECK enum on status)
- [ ] `approvals` is registered as a third read-only collection; the existing `data_version` poll fans changes out as patch/meta automatically
- [ ] `set_approval` is the only write path for approvals; `scripts/approve.ts` is a thin RPC client over it
- [ ] Autopilot renders epic blocks with slugs only, a virtual `close:<epic>` row, and `[pending|approved|rejected]` pills; reframes on any approval change
- [ ] CLAUDE.md, README, and the touched source-file header docstrings reflect the lifted read-only fence and the approvals sidecar's re-fold exclusion
- [ ] `bun test` passes; manual smoke confirmed (approve a task → autopilot reframes within ~50ms)

## Early proof point

Task that proves the approach: `<epic_id>.3` (`set_approval` RPC + CLI). It
is the first end-to-end exercise of the new mutation path — RPC dispatch,
writer-connection lifecycle, error taxonomy, and the CLI's `Bun.connect →
rpc → rpc_result` round-trip all compose for the first time here. If it
fails: investigate the server-worker's writer connection (is the second
`openDb` opening cleanly? does the writer share the same `applyPragmas`
contract?), confirm that the poll loop's reader connection sees the writer
connection's commits via `data_version`, and as a last resort fall back to
the original sketch's direct-DB-write CLI (a `scripts/approve.ts` that
opens its own writer DB and bypasses the RPC) so the approvals feature
still ships while the RPC infrastructure is iterated on.

## References

- The original sketch: `bundle/sketch/autopilot-epic-blocks-with-approvals`
- CLAUDE.md "No client mutations, no reactor, no write path through the socket" — the bullet being lifted by Task 5's docs sweep
- CLAUDE.md "Worker contract" — the server-worker now owns a writer-mode connection AND its existing read-only connection; both follow `applyPragmas` per the connection-local PRAGMA invariant
- `src/server-worker.ts:537-549` — `dispatchLine` REPLACES the active subscription on every `query`; this contract is unchanged (multi-sub per connection is out of scope; the autopilot opens two connections instead)
- `src/collections.ts:18-22` — the injection invariant: only descriptor constants are interpolated into SQL; the new approvals descriptor honors it via a real `approval_id` column (not a compound expression)

## Docs gaps

- **CLAUDE.md** — rewrite the "No client mutations, no reactor, no write path through the socket" DO NOT bullet to reflect the RPC layer; extend the writer-identity invariant to call out the server-worker as the writer of RPC-driven sidecar tables; add a bullet documenting the approvals sidecar's exclusion from the re-fold determinism guarantee
- **README.md** — "What keeper is" lists approvals as a collection and mentions RPCs as the mutation path; "Example clients" describes the new autopilot render shape and adds an `approve.ts` entry; "Inspect" adds a `SELECT * FROM approvals` snippet
- **src/collections.ts** header — drop "future collection" language; list jobs/epics/approvals; note approvals is a sidecar (not a reducer projection)
- **src/db.ts** header — extend the schema-ownership list with approvals + note its sidecar character
- **src/protocol.ts** header — extend the frame-shape catalog with `rpc` + `rpc_result`; update the "Client → server" / "Server → client" lists
- **scripts/autopilot.ts** header — update the render-shape and connection-model description to match the new epic-block view + two-connection design

## Best practices

- **`BEGIN IMMEDIATE` for the writer connection's RPC transactions:** default `DEFERRED` upgrades to writer mid-transaction and ignores `busy_timeout`, surfacing as spurious `SQLITE_BUSY`. Sources: kerkour.com/sqlite-for-servers; Django 5.1+ `transaction_mode=IMMEDIATE`.
- **`PRAGMA data_version` polling sees writes from OTHER connections only:** the server-worker's poll-loop reader and the new RPC writer MUST be distinct connections, or the poll won't see RPC commits. Source: APSW Connection.data_version docs.
- **UPSERT (`INSERT … ON CONFLICT DO UPDATE`), not `REPLACE INTO`:** `REPLACE` deletes the old row and re-inserts, firing DELETE triggers and disturbing future foreign-key children; UPSERT updates in place. Source: sqlite.org/lang_conflict.html.
- **CHECK constraint at the DB layer + validation in the RPC handler:** defense in depth — the CHECK catches schema-level corruption and direct writers; the handler catches typos at the wire boundary before paying SQLite cold-start cost.
- **Absent row = pending:** no row in `approvals` for a given `(epic_id, task_key)` means "pending." Avoids backfilling a row per task at scan time; makes `clear` trivially a DELETE; new tasks auto-default to "pending" with zero coordination.

## Snippet context

Bundles inherited or curated for this epic:
- `sketch/autopilot-epic-blocks-with-approvals` — the original sketch handoff (empty bundle, but the ref forwards the curation chain so future inheritor-tier `render-spec` calls in `/plan:work` can pick up additional snippets added to the bundle later)

No additional snippets curated at the epic level (per-task curation in each task's `snippets:` field — currently empty across all five tasks, since no snippet ids were available at planning time).
