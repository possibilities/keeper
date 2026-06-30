## Description

**Size:** M
**Files:** cli/status.ts (new), cli/query.ts (new), cli/keeper.ts, src/collections.ts (read-allowlist), test/keeper-cli.test.ts, test/status.test.ts (new)

Two one-shot JSON read commands so an agent orients without the TUI
snapshot dance: `keeper status` (unified board + autopilot) and
`keeper query <collection>` (raw allowlisted collection rows).

### Approach

`keeper status --json`: bare `subscribeReadiness` (`src/readiness-client.ts:1404`)
— the first `onSnapshot` is already a complete composite (internal first-paint
gate `:1589-1617`); print the JSON envelope, `handle.dispose()` (`:273-275`),
exit. Mirror the `keeper await server-up` first-paint→dispose shape
(`cli/await.ts`), BUT with a bounded default connect deadline (~10s) via
`giveUpPolicy` → exit 1 `unreachable` when the daemon is down (status is a
one-shot orient, NOT reconnect-forever). Envelope:
`{schema_version:1, ok, error, data}` where `data` = autopilot
`{paused, mode, worktree_mode, armed, max_concurrent_jobs, max_concurrent_per_root}`,
board (epics + per-task/close-row verdicts), aggregate counts, `drained`/`jammed`
booleans (reuse task-4's predicate), in-flight (`pendingDispatches` + running
jobs), needs-human (stuck rows, dead_letters, block_escalations,
finalize-non-ff stickies), and `{rev, catching_up}` from the boot header.
Exit 0 on ANY board state (bad state is data); non-zero only for transport/usage.

`keeper query <collection> [--filter k=v] [--json]`: thin wrapper over
`queryCollection(sockPath, collection, filter?)` (`cli/control-rpc.ts:175-202`
— note: NO `limit` arg, hardcodes `limit:0`; filter is `Record<string,FilterValue>`
supporting `{ne}/{in}/{not_in}`). Author a hard-coded read-allowlist of
collection names in `src/collections.ts` (no `DESCRIPTOR_BY_NAME` registry
exists). Reject an off-allowlist name at PARSE time (exit 1 usage), never a
daemon round-trip. NEVER route through `sendControlRpc` (`:212-232`, the write
path). Map a daemon `error` frame (queryCollection throws) to a clean exit-1
message, never a stack trace on stdout.

Register both in `cli/keeper.ts` via the 3-touch contract (`SUBCOMMANDS`
:22-47, `USAGE` :50-95, lazy `handlers` :161-191), mirroring `git`. Both
`--json` outputs put ONLY JSON on stdout; diagnostics to stderr.

### Investigation targets

**Required** (read before coding):
- cli/keeper.ts:22-47, :50-95, :161-191 — the 3-touch registration contract
- src/readiness-client.ts:1404, :1589-1617, :273-275 — subscribeReadiness, first-paint gate, dispose
- cli/await.ts — the `server-up` first-paint→dispose precedent + `giveUpPolicy` wiring
- cli/control-rpc.ts:175-202 — `queryCollection` signature/behavior
- src/collections.ts:62-75 — `CollectionDescriptor` (no safe-to-expose flag → allowlist authored fresh); registry :828-846
- src/snapshot.ts:42-95 — `SNAPSHOT_SCHEMA_VERSION` / envelope precedent

**Optional:**
- cli/git.ts — a minimal existing subcommand to mirror for shape
- test/keeper-cli.test.ts — routing test pattern (stub handlers, thrower exit shim)

### Risks

- Boot-provisional reads: a one-shot status that prints before catch-up would show a partial board. Carry `catching_up` in the envelope so the agent knows the read is provisional; do not block on it (status is best-effort orient).
- `drained`/`jammed` booleans in `status` should reuse task-4's pure predicate, not reimplement — declared dep on task 3 (await path) but the predicate itself lands in task 4; sequence so `status` imports it. If task ordering makes that awkward, compute inline with a TODO to dedupe, called out in Done summary.

### Test notes

Routing tests in test/keeper-cli.test.ts (stub handlers). A pure shaping test (test/status.test.ts) that feeds a fixture snapshot to the status JSON-builder and asserts envelope shape + field presence — keep the JSON-shaping logic in a pure exported function so it tests without a socket.

## Acceptance

- [ ] `keeper status --json` prints one `{schema_version, ok, error, data}` envelope with the fields above; exit 0 on any board state.
- [ ] Daemon down → bounded ~10s deadline → exit 1 `unreachable` (does NOT hang).
- [ ] `keeper query <collection> --json` returns allowlisted rows; off-allowlist name → exit 1 at parse time; daemon error frame → clean exit 1.
- [ ] Neither command routes through `sendControlRpc`.
- [ ] Both registered in cli/keeper.ts with routing tests; only JSON on stdout.
- [ ] `bun test` green.

## Done summary

## Evidence
