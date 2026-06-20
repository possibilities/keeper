## Description

**Size:** M
**Files:** scripts/autopilot.ts

### Approach

Rewrite `scripts/autopilot.ts` to render the redesigned epic-block view
with approval pills, driven by TWO simultaneous `Bun.connect` sockets (one
`epics` subscription, one `approvals` subscription). The two connections
are necessary because the server's `dispatchLine` REPLACES the active
subscription on every `query` — multi-sub per connection would require a
protocol change beyond this epic's scope.

Four moves:
1. Closure-factor the per-connection plumbing in `scripts/autopilot.ts`
   into a `ConnectionWorker` (a closure factory that returns
   `{ start, stop, getRows }` — closure-based, not a separate file).
   Each worker owns its OWN `currentSock`, `attempt`, `pollTimer`,
   `queryInFlight`, `refetchDirty`, `gotResult`, `order`, `byId`,
   `LineBuffer`. The connection-lifecycle handlers (`open` / `data` /
   `close` / `error`) and the reconnect-with-backoff loop live inside the
   closure. Lifecycle events emit through a SHARED `emitLifecycle` so
   viewers see one ordered narration with an `event_source: epics|approvals`
   detail key.
2. Instantiate TWO `ConnectionWorker`s in `main()`: one for `epics` (the
   existing query shape — `--status` / `--status-ne` flags route to it),
   one for `approvals` (no filter — subscribes to all rows). Both share
   one shared `lastBody` + one shared `emitFrameIfChanged`; either
   worker's result/patch frame triggers a `renderBody()` re-eval.
3. Rewrite `renderBody()`: walk the `epics` worker's `order` (newest-first
   by default sort); for each epic, emit `- epic: <epic_id>`, then either
   `tasks: []` or `tasks:` followed by `- <task_id> [<pill>]` per task
   (drawn from the decoded `epic.tasks` array), and finally one more line
   `- close:<epic_id> [<pill>]` for the virtual close row. The pill is
   looked up from the approvals worker's state via
   `approvalsByKey.get(epic_id + ':' + task_key)`; missing = "pending". The
   existing byte-compare emit-gate stays intact — a pill flip changes the
   rendered text and reframes; a non-rendered cell flip does not.
4. SIGINT cleanly tears down BOTH workers (unsubscribe on each + end
   socket); both workers' `pollTimer`s clear; only one process.exit(0).
   Update the script header docstring to describe the new render shape,
   the close virtual row, the pill rendering rules, and the two-connection
   design (cross-ref the CLAUDE.md note in Task .5 once docs land).

The `approvalsByKey` map is rebuilt wholesale on every approvals `result`
(just as `byId` is for epics today); patches per row are coalesced via
the existing refetch-coalescing loop.

### Investigation targets

**Required** (read before coding):
- scripts/autopilot.ts:251-271 — current `renderBody` (the unit to rewrite)
- scripts/autopilot.ts:213-238 — per-connection state declarations; the closure-factored worker owns these
- scripts/autopilot.ts:359-393 — `handleFrame` (result/patch/meta/error); the closure encapsulates this
- scripts/autopilot.ts:444-491 — `connectOnce` (the unit to closure-extract)
- scripts/autopilot.ts:499-519 — `connectWithRetry` (the backoff loop the closure owns)
- scripts/autopilot.ts:522-534 — SIGINT teardown (must release both workers)
- scripts/autopilot.ts:340-357 — `emitLifecycle` (kept shared; add `event_source` detail key)
- scripts/keeper-frames.ts:343-357 — `renderEpicItem` / `projectTask` in the existing epics-collection renderer; the new `renderBody` in autopilot mirrors this shape (mapping-per-epic with nested tasks: list) but slugs-only and with pill suffix instead of `[<status>]`

**Optional** (reference as needed):
- scripts/keeper-frames.ts (full file) — the intentional clone; the "extract a shared module if a third client appears" comment at `scripts/autopilot.ts:55-58` is now formally triggering, but we keep the closure-factoring INSIDE autopilot.ts for this task (not a separate `scripts/lib/keeper-client.ts`). A future task can extract once a fourth use appears.

### Risks

- **`gotResult` becomes per-worker.** The terminal-error guard in `handleFrame` (`if (!gotResult) process.exit(1)` on an `error` frame before first `result`) must check the right worker's flag. A `unknown_collection` error on the `approvals` subscription against an old daemon should NOT kill the epics rendering — surface a lifecycle warning instead and let epics keep flowing. Document this in the header.
- **`unknown_collection` on first connect against a daemon without Task .2's schema.** Both workers must tolerate this gracefully. Approvals worker's first `error` frame should warn and leave `approvalsByKey` empty; the renderer treats every task as "pending" until the daemon catches up.
- **Double sidecar file writes.** The per-pid sidecar files (`/tmp/autopilot.${pid}.state.json` and `.frame.yaml`) are shared — the render mirrors the combined view, not per-worker; the sidecar write happens at most once per emitted frame.
- **`SIGINT` double-exit.** Two `process.on("SIGINT", …)` registrations would queue; one shared handler is correct, calling each worker's `stop()` once then `process.exit(0)`.

### Test notes

No `scripts/*.test.ts` precedent exists. Document a manual smoke checklist:
- `bun keeperd` running; insert two real epics with two tasks each via planctl
- `bun scripts/autopilot.ts` shows two `epic:` blocks (newest first), tasks listed with `[pending]` pills, a `close:<epic_id> [pending]` row per block
- `bun scripts/approve.ts <epic_id> <task_id> approve` — autopilot frame redraws within ~50ms with `[approved]` on that row
- `bun scripts/approve.ts <epic_id> close:<epic_id> reject` — close row redraws with `[rejected]`
- Kill keeperd; both lifecycle notes appear (`disconnected` for each connection) and the script waits for reconnect
- Restart keeperd; both reconnect and re-emit `connected` lifecycle notes
- Ctrl-C exits cleanly with no orphaned timers / files

If a test pattern emerges (e.g., adopting the integration-test daemon shape
from `test/integration.test.ts`), encode the smoke checklist as a real
test in a follow-up task — not in this one.

## Acceptance

- [ ] `scripts/autopilot.ts` renders the epic-block YAML: one `- epic: <epic_id>` line per page row, followed by `tasks: []` or `tasks:` + `<task_id> [<pill>]` lines, then a `- close:<epic_id> [<pill>]` virtual row
- [ ] Pills render as `[pending]` (no approvals row), `[approved]`, or `[rejected]` — sourced from the second connection's approvals subscription via `approvalsByKey.get(epic_id + ':' + task_key)`
- [ ] Two `ConnectionWorker`s (closure-factored, not a separate file) drive two parallel `Bun.connect` subscriptions; both feed a single shared `lastBody` + `emitFrameIfChanged`
- [ ] Lifecycle notes carry an `event_source: epics|approvals` detail key so a viewer can tell which loop changed
- [ ] SIGINT cleanly stops both workers, releases both sockets, clears both pollTimers, exits 0
- [ ] Header docstring updated to describe the new render shape and the two-connection design
- [ ] Manual smoke checklist (in the task spec) confirmed: launch daemon, see pills change in response to `approve.ts` calls within ~50ms

## Done summary
Rewrote scripts/autopilot.ts: two parallel Bun.connect subscriptions (epics + approvals sidecar) drive a single shared frame; renders newest-first - epic: <epic_id> blocks with nested - <task_id> [<pill>] task lines and a trailing virtual - close:<epic_id> [<pill>] row. Connection plumbing closure-factored into ConnectionWorker; lifecycle notes carry event_source; SIGINT cleanly stops both workers. Smoke-tested live against a running keeperd: render shape + lifecycle channel + non-terminal approvals warn-on-unknown-collection path all behave per spec.
## Evidence
