## Overview

Replace keeper's `approvals` sidecar SQLite table with a planctl-native `approval` field on epics and tasks. Approval becomes a real top-level field on `.planctl/epics/<id>.json` and `.planctl/tasks/<id>.<n>.json`, valued `"approved" | "rejected" | "pending"`. Two new RPCs (`set_task_approval`, `set_epic_approval`) replace the current `set_approval` RPC and write the planctl JSON files directly with atomic temp+rename and per-file single-flight inside keeperd. The change round-trips through `@parcel/watcher` -> plan-worker snapshot events -> reducer -> embedded into the `epics` projection. autopilot drops its second subscription, reads approval off the epics rows, and default-filters out approved epics with a `--show-approved` escape hatch. The CLAUDE.md "Plans are READ-ONLY" / "keeper never writes a .planctl file" invariant is explicitly inverted -- RPCs may write the `approval` field on planctl files and nothing else.

## Quick commands

- `bun scripts/approve.ts epic <epic_id> approved` -- approve an epic
- `bun scripts/approve.ts task <epic_id> <task_id> rejected` -- reject a task
- `bun scripts/autopilot.ts` -- show only pending/rejected epics (default)
- `bun scripts/autopilot.ts --show-approved` -- include approved epics

## Acceptance

- [ ] planctl knows `approval` as a top-level field on epic/task JSON, validates the enum, preserves it on rewrite
- [ ] planctl ships a `set-approval` CLI subcommand
- [ ] keeper has two new RPCs (`set_task_approval`, `set_epic_approval`) that atomically write planctl files
- [ ] keeper schema v13 backfills existing epics to `approved`, overlays sidecar rows, drops `approvals` table + `APPROVALS_DESCRIPTOR` + `Approval` type
- [ ] `epic.approval` and `task.approval` ride through plan-worker snapshots -> reducer -> epics projection
- [ ] re-fold determinism extends to approval (rewind + re-drain reproduces approval state byte-identically)
- [ ] autopilot reads approval from epics rows (no second connection), defaults to `approval != approved`, has `--show-approved`
- [ ] CLAUDE.md + README.md describe the new contract; old invariants explicitly inverted

## Early proof point

Task `.2` (keeper plumbing) proves the approach. If the snapshot round-trip cannot carry the field without breaking `seedFromDb` parity or re-fold determinism, the rest is moot -- pivot to a different approach for surfacing the field (synthetic `ApprovalChanged` event from the RPC, or keep the sidecar with a server-side cross-table filter).

## References

- `CLAUDE.md` lines 81-93, 133-144 -- the two invariants explicitly inverted
- `src/db.ts:539-567` (v6 to v7 with DROP), `src/db.ts:769-773` (v10 to v11 rewind-and-redrain) -- precedents for v12 to v13
- `src/rpc-handlers.ts:39-247` -- the entire `set_approval` handler module to replace
- `scripts/autopilot.ts:257-486` -- `createConnectionWorker` factory (keep for epics, drop for approvals)

## Docs gaps

- **`/Users/mike/code/keeper/CLAUDE.md`**: heavy revision -- rewrite sidecar DO NOT bullet (lines 81-93), invert "Plans are READ-ONLY" bullet (lines 133-144), rewrite "RPC handlers may ONLY write sidecar tables", remove schema-v12 "absent row = pending" prose
- **`/Users/mike/code/keeper/README.md`**: drop `approvals` from collection list, update Mutation section example, update `approve.ts` and `autopilot.ts` descriptions, remove `approvals` schema snippet, qualify "no plan write path"

## Best practices

- **Atomic write must be temp file in SAME directory as target.** POSIX rename atomicity only holds within one filesystem -- cross-filesystem rename falls back to non-atomic copy. [LWN "Ensuring data reaches disk"]
- **No lockfiles for cross-tool coordination.** Stale-lock recovery is hard; optimistic write + watcher-visible convergence is the community stance for two cooperative processes on one machine.
- **DDL needs EXCLUSIVE lock even in WAL mode.** Run schema v13 migration at boot BEFORE spawning worker threads; `BEGIN IMMEDIATE` (not `BEGIN DEFERRED`) to avoid `SQLITE_BUSY_SNAPSHOT`. [SQLite isolation docs]
- **`@parcel/watcher` debounce.** Watcher fires for same-process writes (intended round-trip); use ~150ms `Set` keyed by absolute path + single-flight scheduler. [VS Code/parcel pattern, issue #193]
- **Coerce missing/invalid `approval` to `"pending"` in the fold.** Defensive folding per CLAUDE.md "safe value" invariant; prevents typo failures from breaking re-fold determinism.

## Alternatives

- **Keep the sidecar, add a server-side cross-table filter on the `epics` descriptor.** Less invasive, preserves the "keeper never writes a .planctl file" invariant. Rejected: sets the descriptor's first cross-table-filter precedent, filter logic stays at the query layer (cost for every consumer), and approval state remains carved out of re-fold determinism.
- **Materialize `approval` onto the `epics` row via a trigger or RPC-side direct projection write.** Fastest filter performance. Rejected: makes the RPC a multi-table writer, breaks the projection's single-source rule, re-introduces split-brain risk with the file watcher.
- **Synthetic `ApprovalChanged` event from the RPC handler directly into the event log (bypass the file watcher round-trip).** Rejected: split-brain -- RPC emits the event while the file has not been rewritten yet; a re-fold would disagree with a file re-read. Let the watcher be the single path from file to event.

## Architecture

Approval flows: `approve.ts` (or `planctl set-approval` CLI) -> RPC (or planctl CLI direct write) -> atomic temp+rename on the planctl JSON file -> `@parcel/watcher` -> plan-worker `EpicSnapshot` / `TaskSnapshot` event -> reducer fold -> `epics` projection (top-level `approval` for epic, embedded inside the tasks array element for tasks) -> subscribe socket -> autopilot render.

The file is the canonical source; the watcher round-trip is the single path from file change to projection update; the RPC handler and the planctl CLI are co-equal writers under the single-flight-per-file lock (inside keeperd) and OS-rename atomicity. A re-fold from scratch reproduces approval state from the snapshot events the watcher emitted -- restoring the re-fold determinism guarantee that the sidecar carved out.

## Rollout

Sequenced, two-tool deploy:

1. **Ship planctl change first** (task `.1`). planctl learns `approval`, validates, preserves on rewrite, ships `set-approval`. Independently shippable.
2. **Ship keeper plumbing** (task `.2`). Types, plan-worker, reducer, descriptor filter. Defaults missing `approval` to `"pending"`, so tolerates files written by old planctl.
3. **Ship keeper RPCs + schema v13 migration** (task `.3`). Boots: migration backfills + overlays + drops sidecar; new RPCs register and start writing planctl files. CRITICAL: planctl from step 1 must be deployed or planctl's next rewrite strips the field.
4. **Ship autopilot + approve.ts** (task `.4`). Operator-facing CLI changes; safe after RPCs are live.
5. **Ship docs** (task `.5`). CLAUDE.md invariant inversion + README revisions. Can land anytime after design is locked.

Rollback: a stuck partial deployment (planctl shipped but keeperd boot fails on migration) can revert keeperd to v12 binary -- v12 ignores the unknown `approval` field that planctl preserves, no data loss. The sidecar table can be reconstructed from `epic.approval` values for a future v14 if needed.
