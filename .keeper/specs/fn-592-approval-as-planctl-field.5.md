## Description

**Size:** S
**Files:** `CLAUDE.md` (AGENTS.md symlinks to it -- edit in place), `README.md`

### Approach

`CLAUDE.md`: (a) rewrite the sidecar DO NOT bullet (lines 81-93): replace the "approvals sidecar is NOT a reducer projection" carve-out with the new RPC contract -- handlers write `.planctl` JSON files directly via atomic temp+rename, and `@parcel/watcher` round-trips the change into the epics projection; (b) invert the "Plans are READ-ONLY" bullet (lines 133-144): plans are read-only *except* for the `approval` field, which the two RPCs (`set_task_approval`, `set_epic_approval`) write -- precisely enumerate that ONLY `approval` is RPC-writable; (c) rewrite "RPC handlers may ONLY write sidecar tables (currently: `approvals`)" -> "RPC handlers may write external resources (planctl JSON files via atomic temp+rename); they MUST NOT write reducer projections directly -- projection changes round-trip through plan-worker + event log"; (d) remove schema-v12 "absent row = pending" prose; the new invariant lives in the planctl JSON field (`pending` = explicit or absent); (e) update the "sole writer" sentence -- `approvals` is gone; mention server-worker writes planctl files for `approval`.

`README.md`: (a) drop `approvals` from the collection list in the overview paragraph; (b) update the "Mutation is a separate, scoped path" example from `set_approval` -> `set_task_approval` / `set_epic_approval`; characterize handlers as writing planctl files (not sidecar tables); (c) qualify the "no plan write path through the socket" bullet -- the socket now carries plan mutations scoped to the `approval` field only; (d) rewrite the `approve.ts` description with new command signatures and no `clear` -> DELETE explanation; (e) rewrite the `autopilot.ts` description: no second subscription, approval read from `epic.approval` / `task.approval`, document `--show-approved`; (f) delete the `approvals` table schema-introspection snippet; (g) remove the schema-v12 invariant reference.

### Investigation targets

**Required** (read before coding):
- `CLAUDE.md` (whole file -- note AGENTS.md is a symlink to it, edit in place; do not `rm`+recreate)
- `README.md` (whole file)

### Risks

- Wording precision matters: future code reading the inverted invariant might assume "RPCs can write any planctl field." Enumerate scope explicitly (`approval` only).

### Test notes

No tests -- prose only. Verify: (a) `grep -i 'sidecar' CLAUDE.md README.md` returns only historical/migration mentions, not active-state descriptions; (b) `grep -i 'set_approval' CLAUDE.md README.md` returns zero (vs `set_task_approval` / `set_epic_approval`); (c) `grep -i 'approvals' CLAUDE.md README.md` returns only historical/migration mentions.

## Acceptance

- [ ] CLAUDE.md sidecar DO NOT bullet rewritten to new RPC contract; old text gone
- [ ] CLAUDE.md "Plans are READ-ONLY" bullet inverted with precise enumeration (only `approval` is RPC-writable)
- [ ] CLAUDE.md "RPC handlers may ONLY write sidecar tables" rewritten to write-external-resources scope
- [ ] CLAUDE.md schema-v12 "absent row = pending" prose removed
- [ ] README.md overview drops `approvals` from collection list
- [ ] README.md Mutation section example updated to new RPCs
- [ ] README.md `approve.ts` and `autopilot.ts` descriptions match new behavior
- [ ] README.md `approvals` table schema snippet deleted
- [ ] No stale references to `set_approval`, "approvals sidecar" as active state, or "keeper never writes a .planctl file"

## Done summary
Rewrote CLAUDE.md + README.md to match the planctl-native approval contract: RPC handlers write the approval field on .planctl files via atomic temp+rename and round-trip through the watcher; removed all stale sidecar/set_approval/schema-v12 references.
## Evidence
