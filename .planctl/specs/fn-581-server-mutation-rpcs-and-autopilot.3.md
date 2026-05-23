## Description

**Size:** M
**Files:** src/server-worker.ts (or src/rpc-handlers.ts if extracted), scripts/approve.ts, test/server-worker.test.ts, test/approve.test.ts (or extend test/integration.test.ts)

### Approach

Land the first concrete RPC and the first CLI client over it. End-to-end
proof of the mutation path.

Three moves:
1. Implement `set_approval` handler. Params shape: `{ epic_id: string,
   task_key: string, status: "approved" | "rejected" | "clear" }`. Validate
   all three params are strings; validate status is one of the three
   literals. On "clear", `DELETE FROM approvals WHERE epic_id = ? AND
   task_key = ?` and return `{ cleared: true, epic_id, task_key }`. On
   "approved" / "rejected", compute `approval_id = epic_id + ':' + task_key`,
   `INSERT INTO approvals (approval_id, epic_id, task_key, status,
   updated_at) VALUES (?, ?, ?, ?, unixepoch('now', 'subsec')) ON
   CONFLICT(epic_id, task_key) DO UPDATE SET status = excluded.status,
   updated_at = excluded.updated_at`. Wrap in `BEGIN IMMEDIATE` per the
   epic's Best practices. Return the new row as the rpc_result value.
   Register in `RPC_REGISTRY` under the method name `"set_approval"`.
2. Build `scripts/approve.ts`. Thin RPC client. Use `parseArgs` matching
   autopilot's style. Usage: `bun scripts/approve.ts <epic_id> <task_key>
   approve|reject|clear`. Resolve `KEEPER_SOCK` via `resolveSockPath()`.
   Open one `Bun.connect`, send the rpc frame with a unique id (e.g.
   `crypto.randomUUID()`), await the `rpc_result` or `error` frame via
   `LineBuffer`, print the result (or stderr the error) and exit 0 / 1.
   No subscription, no poll, no reconnect — short-lived single-shot
   client; if daemon is down, fail fast.
3. Tests: handler unit tests for happy path (approve, reject, clear),
   validation rejections (missing param, wrong status, non-string),
   idempotency (approve twice yields one row with stable approval_id,
   updated_at bumps). CLI test via `Bun.spawn` against a test daemon (or
   document this as a manual smoke if the in-test daemon shape isn't
   already established — check `test/integration.test.ts` for the precedent).

The CLI is the only NEW concrete RPC client this task ships, but the
handler itself sets the pattern for future RPCs — keep it shape-defensive
and validation-first.

### Investigation targets

**Required** (read before coding):
- src/server-worker.ts (post-Task-.1 state) — `RPC_REGISTRY` location and registration shape; `dispatchLine` rpc-case to confirm handler invocation contract
- src/collections.ts (post-Task-.2 state) — `APPROVALS_DESCRIPTOR` for the column list the handler INSERTs into
- src/db.ts:42-48 — `resolveDbPath` (handler doesn't open a DB — the writer connection is already open in the server-worker; this is for orientation)
- src/db.ts:57-63 — `resolveSockPath` (CLI uses it)
- src/protocol.ts (post-Task-.1 state) — `RpcFrame` and `RpcResultFrame` for the CLI's frame construction
- scripts/autopilot.ts:185-200 — `parseArgs` usage pattern; `die()` helper; cli help text style
- scripts/autopilot.ts:444-491 — `Bun.connect` + `LineBuffer` round-trip; the CLI uses a stripped-down version (no reconnect, no poll)
- test/integration.test.ts — if a test-daemon pattern exists here, the CLI smoke-test rides it; otherwise document the manual smoke checklist
- test/server-worker.test.ts — handler unit tests live here; check existing patterns for stubbing `Database` if needed

**Optional** (reference as needed):
- plugin/hooks/events-writer.ts:344-379 — the per-invocation `openDb` idiom for hooks; the CLI does NOT use this (it goes through the RPC) but the cold-start budget rationale (~30ms Bun + ~5ms SQLite) explains why the RPC path is faster than direct-DB

### Risks

- **`unixepoch('now', 'subsec')` two-writes-in-same-µs tie.** The `version > lastSent` diff test demands strict monotonicity. SQLite's `unixepoch('now', 'subsec')` has sub-µs resolution per the docs; two CLI calls hitting in the same µs would tie. Vanishingly unlikely in practice; document in the handler comment that for higher-frequency writers this would need an explicit version-bump strategy.
- **CLI failure modes.** Daemon not running (`Bun.connect` ECONNREFUSED) → stderr + exit 1; validation error from server → stderr the error message + exit 1; unknown method (defensive, shouldn't happen) → stderr + exit 1. The CLI must NEVER block waiting for a result it'll never get — set a reasonable connect timeout.
- **"clear" overload.** Mixing delete semantics into a single RPC keeps the surface small but obscures the operation in audit logs. Acceptable tradeoff for this iteration; future could split to `delete_approval`. Document the choice in the handler comment.

### Test notes

- Handler unit tests (no daemon needed; pass a test-scoped Database):
  - happy path: approve → row exists with the expected status + new updated_at; second approve → same row, updated_at bumped
  - reject path: same shape with status="rejected"
  - clear path: DELETE the matching row; returns `{ cleared: true, ... }`; second clear is no-op (zero-row DELETE; still returns success)
  - validation: missing param → `bad_params` error; wrong status → `bad_params`; non-string epic_id → `bad_params`
  - approval_id derivation: `INSERT` lands the right `approval_id = epic_id + ':' + task_key`
- CLI tests (via Bun.spawn against a test daemon — match the precedent in `test/integration.test.ts` if one exists):
  - happy path: cli exits 0 and prints the resulting row to stdout
  - daemon down: cli exits 1 with a clear stderr message
  - validation error: cli exits 1, stderr carries the server's error message verbatim
  - smoke: a real `approve.ts` invocation against a fresh test daemon UPSERTs a row visible via direct DB select

## Acceptance

- [ ] `set_approval` handler registered in `RPC_REGISTRY` under method `"set_approval"`; takes `{ epic_id, task_key, status }` params; validates all three
- [ ] Approve / reject paths UPSERT the row with computed `approval_id` and `unixepoch('now','subsec')` `updated_at`; wrapped in `BEGIN IMMEDIATE`
- [ ] Clear path DELETEs the row; returns success even when no row matched (idempotent)
- [ ] `scripts/approve.ts` parses `<epic_id> <task_key> approve|reject|clear` argv, connects to `KEEPER_SOCK`, sends one rpc frame, prints the result or error, exits 0 / 1
- [ ] Handler unit tests cover happy/clear/validation paths; CLI smoke test (via Bun.spawn or documented manual checklist) covers end-to-end
- [ ] `bun test` passes; manual `bun scripts/approve.ts <epic> <task> approve` against a running daemon writes the expected row

## Done summary

## Evidence
