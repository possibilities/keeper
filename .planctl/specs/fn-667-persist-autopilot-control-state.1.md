## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/collections.ts, src/daemon.ts, src/seed-sweep.ts, keeper/api.py, cli/autopilot.ts, test/reducer.test.ts, test/autopilot.test.ts, test/schema-version.test.ts, CLAUDE.md, README.md

### Approach

Mirror the `dispatch_failures` vertical (fn-661) end-to-end for a new
`autopilot_state` singleton projection.

1. **Schema** (`src/db.ts`): add a `CREATE TABLE autopilot_state` literal
   alongside `CREATE_DISPATCH_FAILURES` and run it in the unconditional
   bootstrap block (`:1794`). Singleton shape: `id INTEGER PRIMARY KEY
   CHECK (id = 1)`, `paused INTEGER NOT NULL`, `last_event_id INTEGER NOT
   NULL`, `created_at REAL NOT NULL`, `updated_at REAL NOT NULL`. Bump
   `SCHEMA_VERSION` (`:60`) to the NEXT FREE integer (read it live — fn-666
   may have taken 45) and add a comment-only stamp slot mirroring the
   v43→v44 slot at `:4313-4338` (no DDL — the bootstrap CREATE does the
   work). Add `autopilot_state` to BOTH from-scratch re-fold DELETE lists
   (`:2620-2622`, `:4286`) so a rewind-and-redrain wipes it.
   **No migration seed row** — the unconditional boot-append (step 4) folds
   the row before the server-worker serves, so no viewer ever reads an empty
   surface, and skipping the seed keeps `created_at` derived purely from the
   log (re-fold determinism). Note the ~1-event-per-boot log-growth tradeoff
   in the slot comment.

2. **Event + fold** (`src/reducer.ts`): define an `AutopilotPausedPayload`
   (`{ paused: boolean }`) + `extractAutopilotPausedPayload` (defensive —
   returns null on any structural miss, never throws), mirroring
   `extractDispatchFailedPayload` (`:2694`). Add `foldAutopilotPaused`:
   `INSERT INTO autopilot_state (id, paused, last_event_id, created_at,
   updated_at) VALUES (1, ...) ON CONFLICT(id) DO UPDATE SET paused=...,
   last_event_id=..., updated_at=...` — preserve `created_at` on the UPDATE
   branch (like `foldDispatchFailed`), derive `updated_at`/`created_at` from
   `event.ts`. A malformed payload folds to a safe no-op and the cursor
   still advances. Wire the `else if (event.hook_event === "AutopilotPaused")`
   arm into the chain at `:5852`.

3. **Collection** (`src/collections.ts`): add an `AUTOPILOT_STATE_DESCRIPTOR`
   (single-column `pk: "id"` — singleton sidesteps the single-column-pk
   limit) and a REGISTRY entry (`:669-678`). Zero wire-protocol change.

4. **RPC append + boot-append** (`src/daemon.ts`):
   - In the `set-autopilot-paused-request` bridge (`:884-922`): append the
     `AutopilotPaused` synthetic event FIRST via `stmts.insertEvent.run({...})`
     (copy the binding block from the retry-dispatch handler at `:937`,
     `$hook_event: "AutopilotPaused"`, `$event_type: "autopilot_state"`,
     `$ts: Date.now()/1000`, payload `{paused}`), then `wakePending = true;
     pumpWakes()`, then flip `autopilotPaused` + relay `set-paused` to the
     worker ONLY on a successful insert (mirror the retry handler's
     try/catch → `ok:false`). Order matters: gate and projection must not
     diverge on a partial failure.
   - In the boot drain block (`:727-731`, inside `withBootDrainCheckpointTuning`,
     alongside `seedKilledSweep`): unconditionally append an
     `AutopilotPaused{paused:true}` re-arm, then let the trailing
     `drainToCompletion` fold it BEFORE `serverWorker` spawns (`:827`). Use a
     raw `db.run` INSERT like `insertKilledEvent` (`src/seed-sweep.ts:130-167`)
     — `stmts.insertEvent` is not available at sweep time; keep the column list
     in sync with the prepared-statement form.

5. **Viewer** (`cli/autopilot.ts`): drop the hardcoded `state.paused = true`
   (`:748-755`); add a second `subscribeCollection({ collection:
   "autopilot_state", onRows })` (helper at `src/readiness-client.ts:994`,
   pattern at `:803`) that sets `state.paused` from the folded row and
   re-renders the banner. Confirm both this and the existing
   `dispatch_failures` subscribe re-subscribe cleanly on socket drop.

6. **keeper-py** (`keeper/api.py`): add the new version to
   `SUPPORTED_SCHEMA_VERSIONS` (`:93`) + the comment block (`:77-90`) in THIS
   change (hard whitelist — every `commit-work` on the host fails otherwise).

7. **Docs**: update CLAUDE.md + README per the epic `## Docs gaps`.

The worker's dispatch gate (`src/autopilot-worker.ts:552/591`), its
`workerData.paused` boots-paused source (`:1003`), and the `set-paused`
message channel (`:1033`) are UNCHANGED — this is persistence + viewer-truth
only. The in-memory `autopilotPaused` variable is retained (worker relay +
boot-race guard); the projection is added alongside, not as a replacement.

### Investigation targets

**Required** (read before coding):
- `src/reducer.ts:2694-2886` — `DispatchFailedPayload` / `extractDispatchFailedPayload` (defensive→null) / `foldDispatchFailed` (UPSERT, created_at preserve) / `foldDispatchCleared`; the exact shape to mirror
- `src/reducer.ts:5852-5855` — the `hook_event` arm chain; add the `AutopilotPaused` arm here
- `src/db.ts:60` — `SCHEMA_VERSION` (read live, bump to next free); `:1071-1083` + `:1794` — `CREATE_DISPATCH_FAILURES` literal + bootstrap CREATE; `:4313-4338` — v43→v44 ALTER-slot pattern; `:2620-2622` + `:4286` — the two from-scratch re-fold DELETE lists
- `src/daemon.ts:884-922` — the `set-autopilot-paused-request` bridge (today writes nothing); `:924-987` — the retry-dispatch mint template to copy; `:727-731` — boot drain block (boot-append site); `:827` — `serverWorker` spawn (must fold before this)
- `src/seed-sweep.ts:130-167` — `insertKilledEvent`, the boot-time raw-`db.run` synthetic-append pattern
- `src/collections.ts:634-678` — `DISPATCH_FAILURES_DESCRIPTOR` + REGISTRY map
- `cli/autopilot.ts:748-755` (hardcoded `paused:true`) + `:803` (the `dispatch_failures` subscribeCollection to mirror); `src/readiness-client.ts:994` — the `subscribeCollection` helper
- `keeper/api.py:77-93` — `SUPPORTED_SCHEMA_VERSIONS` frozenset + comment block

**Optional** (reference as needed):
- `src/autopilot-worker.ts:552`, `:591`, `:1003`, `:1033-1042` — dispatch gate, `workerData.paused` boot, `set-paused` handler (all UNCHANGED — context only)
- `src/rpc-handlers.ts` — the existing `set_autopilot_paused` handler (already wired end-to-end)
- `test/reducer.test.ts:12114-12300` — the `dispatch_failures` fold-test block to mirror (UPSERT, created_at preserve, null field, DELETE, no-op on missing, malformed→safe-no-op+cursor-advance)
- `test/autopilot.test.ts:283`/`:358` — viewer unit tests (`projectFailedRows`, `renderBody` with `paused`)
- `test/schema-version.test.ts:56-64` — `max(SUPPORTED) >= SCHEMA_VERSION` assertion

### Risks

- **Re-fold determinism**: with no migration seed, the singleton row exists only after the first `AutopilotPaused` folds — so the fold MUST use `INSERT ... ON CONFLICT` (insert-when-absent), and `created_at` must come from `event.ts` (never `Date.now()`). A re-fold (DELETE + redrain) must reproduce a byte-identical row. Add an explicit re-fold-determinism test.
- **Boot-append fold ordering**: if the re-arm event is not folded before `serverWorker` spawns (`:827`), a viewer subscribing the instant the socket opens reads an empty/stale surface — reintroducing the divergence bug. Verify the trailing `drainToCompletion` runs after the append.
- **Two insert sites drift**: the steady-state RPC path (`stmts.insertEvent`) and the boot-append (raw `db.run`) carry duplicate `events` column lists — a future column add must touch both (same fragility flagged in `seed-sweep.ts:124`).
- **keeper-py whitelist miss** fails every `commit-work` host-wide — bump it in the same change.
- **SCHEMA_VERSION race with fn-666**: read the live value at code time; do not hardcode the integer from this spec.

### Test notes

- Reducer: mirror the `dispatch_failures` fold-test block — UPSERT from event payload, `created_at` preserved across re-pause, malformed payload → safe no-op with cursor advance, and a re-fold-from-scratch determinism test (two flips → row matches last event).
- Viewer: a `renderBody`/banner test driving `state.paused` off a subscribed `autopilot_state` row (both `paused=1` → `[paused]` and `paused=0` → `[playing]`); drop/replace the assertion that depended on the hardcoded `true`.
- `test/schema-version.test.ts` must stay green (keeper-py bumped same change).

## Acceptance

- [ ] `autopilot_state` singleton table created in the bootstrap block; `SCHEMA_VERSION` bumped to the next free integer with a comment-only stamp slot; table added to both from-scratch re-fold DELETE lists; no migration seed row
- [ ] keeper-py `SUPPORTED_SCHEMA_VERSIONS` + comment block updated in the same change; `test/schema-version.test.ts` passes
- [ ] `AutopilotPaused{paused:boolean}` event + defensive extractor (→null, never throws) + `foldAutopilotPaused` UPSERT (created_at preserved, derived from `event.ts`); malformed payload → safe no-op with cursor advance; arm wired into the reducer chain
- [ ] `set_autopilot_paused` bridge appends the event FIRST, then flips the in-memory flag + relays to the worker only on a successful insert
- [ ] Main boot-appends `AutopilotPaused{paused:true}` in the boot drain block, folded before `serverWorker` spawns
- [ ] Collection descriptor + REGISTRY entry added; viewer drops the hardcoded `state.paused=true` and subscribes to `autopilot_state`, banner reflects real paused/playing and updates live
- [ ] Worker dispatch gate / `workerData.paused` / `set-paused` channel unchanged; in-memory `autopilotPaused` retained
- [ ] CLAUDE.md (synthetic-event list, RPC carve-out #5, autopilot-dispatch-gates banner note) + README (viewer/reconciler prose, schema-version trail) updated
- [ ] reducer fold tests (UPSERT, created_at preserve, malformed no-op + cursor advance, re-fold determinism) + viewer banner test added; full suite + lint pass

## Done summary
Schema v47 autopilot_state singleton projection with AutopilotPaused synthetic event end-to-end: schema + fold + collection descriptor + RPC bridge (event-FIRST, then in-memory flip) + boot-append re-arm + viewer subscribe. keeper-py whitelist updated; tests + docs in same change.
## Evidence
