## Description

**Size:** M
**Files:** cli/handoff.ts, cli/keeper.ts, src/server-worker.ts, src/rpc-handlers.ts, src/daemon.ts, src/reducer.ts

### Approach

Build the enqueue half end-to-end, mirroring the `set_epic_armed` 5-hop RPC
surface. New `cli/handoff.ts`: a `keeper handoff` verb (free-form
`--prompt`/`--prompt-file` + `--title` + `--session` + `--no-prefix`) that reads
`KEEPER_TMUX_SESSION` + `TMUX_PANE`, applies `handoff_prompt_prefix` (default
empty; `/hack ` via config), caps the doc at 64KB (REJECT with exit 2 over cap —
do NOT truncate), and sends a `request_handoff` RPC; AND a
`keeper handoff show <id>` read verb that queries the `handoffs` collection and
prints the stored doc body (the dispatched worker's first call). Register both in
`cli/keeper.ts` SUBCOMMANDS. Wire `request_handoff` as the SIXTH mutating RPC:
add to `MUTATING_RPC_METHODS`, a validate+bridge handler in `src/rpc-handlers.ts`
(mirror `setEpicArmedHandler`), the bridge method posting
`{kind:"request-handoff-request"}`, and the main-side mint in `src/daemon.ts`
(mirror the set-epic-armed mint): resolve `initiator_job_id` best-effort by
querying `jobs` by `TMUX_PANE` (MAIN is the writer, has the full jobs projection —
null-tolerant), then `stmts.insertEvent.run` a `HandoffRequested` synthetic event
(`$hook_event:"HandoffRequested"`, `$event_type:"handoffs"`, FULL `$` column
list) carrying a stably-minted `handoff_id` (the idempotency key), doc, title,
`target_session`, raw coords, resolved `initiator_job_id`. Add
`foldHandoffRequested` in `src/reducer.ts`: UPSERT the `handoffs` row
(status="requested") AND write the handoff-from `HandoffLinkEntry` onto the
initiator job via a new enrich/merge/sort helper modeled on
`enrichJobLink`/`mergeJobLinkSlice` (KEY ORDER LOCKED for byte-identical
re-fold). Register `handoffs` as a queryable collection so `keeper handoff show`
+ the board can read it.

### Investigation targets

**Required** (read before coding):
- cli/autopilot.ts:470-481 — buildSetArmedFrame + cli/control-rpc.ts:187 — the CLI→RPC wire template
- src/server-worker.ts:1978-1983 — MUTATING_RPC_METHODS; :1747 — boot gate
- src/rpc-handlers.ts:266-326 — setEpicArmedHandler (validate+bridge); :423-429 — installRpcHandlers
- src/server-worker.ts:3281-3302 — bridge impl; :242-255 — request/result message types
- src/daemon.ts:2124-2199 — set-epic-armed-request main mint (FULL $ column list — every insertEvent spells all columns)
- src/reducer.ts:3778-3793 — foldDispatched UPSERT template; :5450-5514 — enrichJobLink/mergeJobLinkSlice/sortJobLinks (KEY ORDER LOCKED)
- cli/dispatch.ts:312-334 — resolveSession; :510-530 — prefix application + --no-prefix; :256-272 — collection-read seam
- src/dispatch-command.ts:133-159 — validatePromptBytes (the cap pattern; NOTE the 64KB doc cap is a SEPARATE replay-cost cap, not the argv cap)

**Optional** (reference as needed):
- test/rpc-handlers.test.ts:308-361 — stub-bridge round-trip test template; test/control-rpc.test.ts — wire test
- the jobs table pane column (backend_exec_pane_id) used for initiator resolution

### Risks

- `initiator_job_id` may resolve null (initiator pane not yet folded) — tolerate; always store raw coords; the from-link is half-anchored in that rare case (no v1 backfill).
- The doc body lives inline in events.data forever (a fold reads it) — the 64KB cap is load-bearing; enforce at the CLI.
- A new mutating RPC bypasses the catching-up/server_booting gate unless added to MUTATING_RPC_METHODS.
- NEVER throw in foldHandoffRequested — malformed data folds to a safe no-op, cursor advances.

### Test notes

- rpc-handlers.test.ts: request_handoff handler forwards params + BadParamsError on bad shape (mirror setEpicArmed test).
- reducer-projections.test.ts: HandoffRequested folds → handoffs row status=requested + from-link on the initiator job; malformed data → no-op; byte-identical re-fold.
- A cli/handoff over-cap doc rejects with exit 2.

## Acceptance

- [ ] `keeper handoff --prompt "..."` enqueues: request_handoff RPC → HandoffRequested event → handoffs row (status=requested)
- [ ] `keeper handoff show <id>` prints the stored doc body
- [ ] request_handoff in MUTATING_RPC_METHODS; validate+bridge handler; main mint with full column list
- [ ] foldHandoffRequested writes the handoffs row + handoff-from link; pure, never throws, byte-identical re-fold
- [ ] initiator_job_id resolved best-effort by pane; raw coords always stored; doc capped at 64KB (reject, not truncate)
- [ ] test:full green

## Done summary
Built the keeper handoff enqueue half: cli/handoff.ts (--prompt/--prompt-file/--title/--session/--no-prefix, 64KB doc cap, handoff_prompt_prefix) + handoff show read verb; request_handoff as the SIXTH mutating RPC (validate+bridge handler, daemon mint of HandoffRequested with best-effort initiator_job_id by pane); foldHandoffRequested UPSERTs the handoffs row (status=requested) + writes the handoff-from link onto the new jobs.handoff_links column (v88 ALTER); handoffs registered as a queryable collection. test:full green on all touched files.
## Evidence
