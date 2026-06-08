## Description

**Size:** M
**Files:** src/rpc-handlers.ts, src/server-worker.ts, src/daemon.ts, cli/autopilot.ts, CLAUDE.md, README.md, test/rpc-handlers.test.ts, test/autopilot.test.ts

The control plane: two new RPCs widen the write surface, the daemon appends
the synthetic events, the CLI gains `arm`/`disarm`/`mode`, and the autopilot
screen shows mode + the armed list.

### Approach

- **RPCs** (src/rpc-handlers.ts): `set_autopilot_mode` (`{ mode: "yolo"|"armed" }`, validate the enum) and `set_epic_armed` (`{ epic_id: string, armed: boolean }`, append unconditionally — no existence validation, to avoid the fold-lag race where a freshly-planned epic can't be armed yet). Clone `setAutopilotPausedHandler` (:457-513) + its param validator; register both via `registerAsyncRpc` (:678).
- **Bridge messages** (src/server-worker.ts:190-216): clone the `SetAutopilotPaused{Request,Result}Message` shapes for set-mode and set-epic-armed; wire the bridge promise methods (mirror `setAutopilotPaused` ~:2719).
- **Daemon bridge** (src/daemon.ts:1734-1827): on each request, append the synthetic event FIRST (full ~30-column `stmts.insertEvent.run({...})` — copy the column list verbatim, `$session_id:"autopilot"`, the matching `$event_type`), call `pumpWakes()`, reply ok. **APPEND-ONLY — no `postMessage` relay to the worker** (deliberately unlike set-paused): the `data_version` bump from the fold wakes the level-triggered reconciler, which re-reads mode/armed from the projection. No boot re-arm for mode (durable user intent, not a safety reset like paused).
- **CLI** (cli/autopilot.ts): add `arm <epic-id>` / `disarm <epic-id>` → `set_epic_armed` (armed true/false) and `mode <yolo|armed>` → `set_autopilot_mode`, in the subcommand dispatch (:766-794); clone `buildSetPausedFrame`/`buildRetryFrame` (:434-453) into `buildSetModeFrame`/`buildSetArmedFrame`; update `HELP` (:100-126). Reuse the `sendControlRpc` one-shot client.
- **Screen** (cli/autopilot.ts): subscribe the `autopilot_state` (mode) + `armed_epics` collections; extend the banner (:611) to show mode + armed count — render the empty-armed-set-in-armed-mode case distinctly (e.g. `[playing] · armed · nothing armed`) so idle-by-design isn't mistaken for broken. Add an `--- armed ---` section listing the explicitly-armed epic ids (v1 shows explicit-armed only; the dep-pulled-in/effective-set view is a documented future enhancement).
- **Docs**: update CLAUDE.md `## Writes are tightly scoped` (add the two verbs, fix the count/framing) + `## Autopilot` (yolo/armed enum, armed_epics, dep-closure); update README RPC paragraph + non-goals + `keeper autopilot` CLI subsection.

### Investigation targets

**Required** (read before coding):
- src/rpc-handlers.ts:457-513 + :678 — `setAutopilotPausedHandler`, validator, `registerAsyncRpc`.
- src/server-worker.ts:190-216 — bridge message shapes; ~:2719 — the `setAutopilotPaused` bridge promise method.
- src/daemon.ts:1734-1827 — the set-autopilot-paused bridge handler (event-append-then-relay); note we DROP the relay. :1769-1801 — the full insertEvent column list to copy verbatim.
- cli/autopilot.ts:434-453 (frame builders), :766-794 (subcommand dispatch), :611 (banner), :100-126 (HELP).
- CLAUDE.md `## Writes are tightly scoped — DO NOT widen them` (currently names the four surfaces) + `## Autopilot`.

**Optional** (reference as needed):
- README.md ~178-206 (RPC surface), ~212-223 (non-goals), ~800-841 (keeper autopilot CLI subsection).

### Risks

- The insertEvent call binds ~30 columns; copy the list verbatim or a binding mismatch throws on append.
- Dropping the relay is intentional but counterintuitive vs the paused template — leave a comment so it isn't "fixed" back to a relay.
- Widening the RPC write surface without updating the CLAUDE.md "ONLY four surfaces" enumeration leaves a stale, misleading invariant doc.

### Test notes

- RPC round-trip tests (mirror rpc-handlers/server-worker tests): mode set folds the singleton; epic arm/disarm folds the presence table; enum validation rejects bad mode.
- CLI: frame builders produce the right method/params; subcommand dispatch wires arm/disarm/mode.
- Screen/banner: mode + armed-count render; empty-armed-in-armed-mode renders distinctly; armed section lists armed ids.
- Slow-tier integration tests use the fn-747 in-process daemon harness (see epic dep).

## Acceptance

- [ ] `set_autopilot_mode` + `set_epic_armed` registered; daemon appends `AutopilotMode`/`EpicArmed` and pumps (no relay); RPCs round-trip.
- [ ] `keeper autopilot mode <yolo|armed>` / `arm <epic>` / `disarm <epic>` work end-to-end; HELP updated.
- [ ] Autopilot screen banner shows mode + armed count (empty-armed case distinct); `--- armed ---` section lists explicitly-armed epics.
- [ ] CLAUDE.md "writes are tightly scoped" + "Autopilot" sections and README RPC/CLI/non-goals updated to include the two verbs and the mode/armed model.

## Done summary

## Evidence
