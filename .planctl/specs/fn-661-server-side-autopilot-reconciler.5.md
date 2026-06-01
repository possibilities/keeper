## Description

**Size:** M
**Files:** cli/autopilot.ts, test/autopilot.test.ts

### Approach

Rewrite `cli/autopilot.ts` into a thin, stateless viewer + control surface (large
net deletion). Subscribe via `subscribeReadiness` (board.ts:809 precedent) and
render: `current` from live `jobs`, `predicted` from a client-side
`computeReadiness` pass, `failed` from the new `dispatch_failures` collection,
plus the paused/playing flag. Add `play` / `pause` / `retry <verb::id>`
subcommands that send `set_autopilot_paused` / `retry_dispatch` RPCs using the
client-side RPC send shape from `scripts/approve.ts:161-396`. DELETE everything
dispatch-side: the dispatch loop, `dispatch.log` + its hydration (`:1478-1700`),
the settling gate, suppression logic, `isLiveSessionInRoot`, `surfaceRef`/
`windowId`, and the `dispatchedKeys`/`fulfilledKeys`/`completedKeys` sets. No
dispatch or dedup logic may remain client-side.

### Investigation targets

**Required** (read before coding):
- cli/board.ts:809 — subscribeReadiness usage (render-only client pattern to mirror)
- src/readiness-client.ts — subscribeReadiness / subscribeCollection (reuse; do not hand-roll a socket loop)
- scripts/approve.ts:161-396 — client-side RPC send ({type:"rpc",id,method,params} → await rpc_result/error)
- cli/autopilot.ts:1478-1700 — dispatch.log hydration to delete; :855 isLiveSessionInRoot; the dispatch loop / settling / suppression

**Optional** (reference as needed):
- The DISPATCH_FAILURES collection descriptor (task 1) — the new section's data source

### Risks

- fn-660 (open epic) also rewrites cli/autopilot.ts (extracting createViewShell) — this epic depends on it; consume createViewShell rather than re-rolling the TUI shell.
- Preserve the render UX the human relies on (current/predicted/failed sections).
- Easy to leave dead imports / helpers behind after the big deletion — grep for retired symbols.

### Test notes

- autopilot.test.ts: heavy rewrite — drop assertions on the retired surface-probe / dispatch.log / settling logic; assert the three render sections from fixtures and that pause/play/retry emit well-formed RPC frames.

## Acceptance

- [ ] `keeper autopilot` renders current / predicted / failed + paused state, reusing subscribeReadiness + computeReadiness
- [ ] play / pause / retry subcommands send set_autopilot_paused / retry_dispatch RPCs
- [ ] dispatch loop, dispatch.log + hydration, settling gate, suppression, isLiveSessionInRoot, surfaceRef/windowId, and the tracking sets are all removed
- [ ] autopilot.test.ts rewritten and green; no dispatch/dedup logic remains client-side

## Done summary
Rewrote cli/autopilot.ts as a thin read-only viewer reusing createViewShell + subscribeReadiness + subscribeCollection(dispatch_failures), plus three one-shot control subcommands (pause/play/retry) that send set_autopilot_paused / retry_dispatch RPCs. Deleted ~2400 lines of dispatch loop, dispatch.log + hydration, settling/suppression gate, isLiveSessionInRoot, surfaceRef/windowId, and the dispatchedKeys/fulfilledKeys/completedKeys tracking sets — no dispatch or dedup logic remains client-side. Test suite rewritten end-to-end to assert the three render sections and well-formed RPC frame shape; scripts/commands.ts re-routed to import buildWorkerCommand from src/autopilot-worker.
## Evidence
