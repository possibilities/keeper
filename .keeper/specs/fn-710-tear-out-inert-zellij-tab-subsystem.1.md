## Description

**Size:** M
**Files:** src/daemon.ts, src/zellij-events.ts, src/zellij-events-worker.ts, src/backend-worker.ts, src/reducer.ts, src/exec-backend.ts, src/autopilot-worker.ts, cli/plugin.ts, cli/keeper.ts, src/db.ts, test/zellij-events-worker.test.ts, test/reducer.test.ts, test/exec-backend.test.ts, test/autopilot-worker.test.ts, test/plugin-path-cli.test.ts, test/plugin-version-skew.test.ts, README.md, CLAUDE.md

Remove the now-inert zellij feed consumer + renamer/reap support. NO schema
change — `jobs.backend_exec_{tab_id,tab_name}` are left dead-but-present for
Task 2 to drop. Daemon must boot + shut down clean with one fewer worker.

### Approach

1. **Delete** src/zellij-events.ts + src/zellij-events-worker.ts. Delete src/backend-worker.ts wholesale (its sole live export `readLiveJobsWithCoords` is called only by the dead consumer + its dead test).
2. **daemon.ts** — remove `scanZellijEventsDir` (~745-1196) + the boot mkdir/scan (~1598-1640) + the zellij-events worker spawn/onmessage/onerror/close (~2804-2885) + shutdown postMessage (~3306) + `exited(zellijEventsWorker)` (~3335) + `terminate()` (~3393) + the `readLiveJobsWithCoords` import (:106) + the `traceZellijMints` counter (~646) + the `resolveZellijEventsDir` use. Drop zellij-events from the @parcel/watcher pre-warm list. Reconcile EVERY worker-count statement (boot comment says "TWELVE", shutdown says "ELEVEN" — both drifted; the true post-teardown count is TEN) and the module-JSDoc worker fleet summary.
3. **reducer.ts** — delete `extractBackendExecSnapshot` (:3741) + `foldBackendExecSnapshot` (:3795). CRITICAL: in the dispatch if/else-if (:7628-7669), REPLACE the `else if (event.hook_event === "BackendExecSnapshot")` arm with an explicit EMPTY no-op arm (comment it "retired fn-684 — fold to no-op so historical events advance the cursor without touching the jobs projection"). Do NOT delete the arm — the final `else` runs `projectJobsRow`, so deletion would route historical events into the jobs projection and break re-fold determinism. KEEP the COALESCE arm (:7320-7369) untouched.
4. **exec-backend.ts** — delete `renameTab` (:1063) + `resolveTabForPane` (:1103) + their arg builders (`buildZellijRenameTabArgs`). After reap removal `closeByTabId` (:1002) has no caller — delete it + `buildZellijCloseTabArgs`. KEEP `focusPane` (:1041, self-contained, used by the `v` keybind) + `launch`.
5. **autopilot-worker.ts** — remove window-reap: the reap decision block (~833-889), the reap loop in runReconcileCycle (~1034-1049), the `closeByTabId` dep field + wiring (~1028, ~1401), the `backend_exec_tab_id` read (~876), and the `PlannedReap` shape. The `autocloseWindows` config gate becomes dead.
6. **cli** — delete cli/plugin.ts wholesale; remove `plugin-path` from cli/keeper.ts (subcommand table :33, help :49, dispatch :129). Delete the dangling `resolveZellijBridgeWasmPath` (db.ts:398-419).
7. **Docs (code-adjacent)** — CLAUDE.md: remove BackendExecSnapshot from the sole-writer list; excise the zellij feed-dir no-kernel-watcher carve-out + the fn-684 out-of-process-producer paragraph; drop tab-namer/zellij from the kick-worker list (Three→Two: server+plan); remove the autopilot reap callouts; reconcile worker count. KEEP the ZELLIJ env-capture scraping rule (capture stays). README: delete the zellij bridge-plugin sections (rebuild + dotfiles wiring), the trace-zellij (KEEPER_TRACE_ZELLIJ) section, the ninth-worker (zellij-events) narrative, the plugin-path mention, the autoclose_windows/zellij_session config bullets; reconcile worker count + the @parcel/watcher worker list (six→five).

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:7628-7669 — the dispatch if/else-if (NO default no-op); :3741/:3795 extract+fold; :7320-7369 COALESCE arm (KEEP)
- src/daemon.ts:745-1196 scanZellijEventsDir; :2804-2885 worker spawn; :3306/:3335/:3393 shutdown; :106 import; :646 trace; worker-count comments :12/:73/:3310
- src/exec-backend.ts:1002 closeByTabId, :1041 focusPane (KEEP), :1063 renameTab, :1103 resolveTabForPane
- src/autopilot-worker.ts:833-889 reap decision, :1034-1049 loop, :876 tab_id read, :1028/:1401 closeByTabId dep, :400-410 PlannedReap
- src/backend-worker.ts (whole module dies); src/db.ts:398-419 wasm resolver
- cli/plugin.ts (whole file); cli/keeper.ts:33/49/129

**Optional** (reference as needed):
- test/reducer.test.ts:15396-15510 — the BackendExecSnapshot fold + re-fold tests to REWRITE
- CLAUDE.md zellij/worker-contract sections; README zellij sections

### Risks

- **HIGHEST: deleting the fold arm instead of replacing it** routes historical BackendExecSnapshot events into projectJobsRow → silent re-fold divergence. Must be an explicit empty no-op arm. Pinned by the rewritten re-fold test.
- **Over-deleting live backend coords:** type/session_id/pane_id + the COALESCE arm + the hook capture + restore grouping + focusPane STAY. Only tab_id/tab_name + the feed go. The collections.ts:134-146 comment and README v48 block MIX live+dead facts — surgical edits only.
- **Worker-lifecycle:** ensure the shutdown await-all array + terminate calls no longer reference the removed worker, or shutdown hangs / throws. Verify daemon boots + shuts down clean.
- **Straggler refs:** after bulk removal, grep `zellij-events|scanZellij|readLiveJobsWithCoords|renameTab|resolveTabForPane|closeByTabId|BackendExecSnapshot|plugin-path|autocloseWindows|resolveZellijBridgeWasmPath` to catch dangling imports/callers.

### Test notes

- Delete test/zellij-events-worker.test.ts, test/plugin-path-cli.test.ts, test/plugin-version-skew.test.ts.
- test/reducer.test.ts:15396-15510 — REWRITE (not delete): assert a historical BackendExecSnapshot folds to a no-op (no jobs write, cursor advances) and a cursor=0 re-fold over a log containing one stays byte-identical. Keep this as the regression guard.
- test/exec-backend.test.ts — drop the renameTab/closeByTabId/resolveTabForPane builder tests; keep focusPane/launch.
- test/autopilot-worker.test.ts — drop the reap tests.
- Update worker-count assertions in test/daemon.test.ts if any.
- `tsc` green + `bun test` green; daemon boot/shutdown verified.

## Acceptance

- [ ] zellij-events.ts, zellij-events-worker.ts, backend-worker.ts, cli/plugin.ts deleted; scanZellijEventsDir + the worker wiring gone from daemon.ts
- [ ] BackendExecSnapshot dispatch arm REPLACED with an explicit no-op (not deleted); extract+fold deleted; COALESCE arm + hook capture untouched
- [ ] renameTab, resolveTabForPane, closeByTabId removed; focusPane + launch kept; window-reap + closeByTabId plumbing gone from autopilot-worker
- [ ] plugin-path removed from cli/keeper.ts; resolveZellijBridgeWasmPath deleted
- [ ] worker counts reconciled (→ ten) across daemon.ts + module JSDoc; kick-worker list = two
- [ ] re-fold-determinism test rewritten to assert the no-op; tsc + bun test green; daemon boots/shuts down clean
- [ ] code-adjacent CLAUDE.md/README zellij + reap + plugin-path sections removed; ZELLIJ env-capture rule KEPT; NO schema change in this task

## Done summary
Removed zellij feed consumer (zellij-events.ts, zellij-events-worker.ts, backend-worker.ts, cli/plugin.ts), replaced BackendExecSnapshot dispatch arm with explicit no-op preserving re-fold determinism, removed renameTab/resolveTabForPane/closeByTabId from ExecBackend, stripped autopilot window-reap, removed plugin-path CLI, and updated CLAUDE.md/README.md to reflect the reduced ten-worker fleet.
## Evidence
