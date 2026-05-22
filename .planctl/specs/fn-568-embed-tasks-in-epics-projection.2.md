## Description

**Size:** M
**Files:** src/plan-worker.ts, src/daemon.ts, src/reducer.ts, test/plan-worker.test.ts, test/reducer.test.ts, test/integration.test.ts

Make a task/epic file deletion retract its projection state while the daemon
is running, via synthetic tombstone events (the only replay-deterministic way
to fold a delete).

### Approach

1. **Producer** (`src/plan-worker.ts`): `PlanScanner.onDelete` stops being a
   pure change-gate drop. For a deleted `.planctl/tasks/<id>.json`, recover
   the `epicId` by parsing the change-gate's last-emitted `PlanTaskMessage`
   for that id, then post `{ kind: "plan-task-deleted", id, epicId }`. For a
   deleted `.planctl/epics/<id>.json`, post `{ kind: "plan-epic-deleted", id }`.
   Drop the change-gate entry after emitting. If no last-emitted snapshot
   exists (never folded), emit nothing (nothing to retract).
2. **Main** (`src/daemon.ts` `planWorker.onmessage`): turn the two new
   message kinds into synthetic `TaskDeleted` / `EpicDeleted` events on the
   writable connection (entity id in `session_id`; for `TaskDeleted` carry
   `epic_id` in the `data` blob), then `pumpWakes()` — same pipeline as the
   snapshot messages. Main stays the sole synthetic-event writer.
3. **Reducer** (`src/reducer.ts`): route `TaskDeleted` / `EpicDeleted`
   through `applyEvent` into `projectPlanRow` (or a sibling). `TaskDeleted`:
   read the parent epic's `tasks` (via `epic_id` from the blob), splice out
   the element by `task_id`, re-sort, write back, bump `last_event_id` /
   `updated_at` (so the retraction `patch`es). A missing epic / element is a
   no-op (idempotent). `EpicDeleted`: `DELETE FROM epics WHERE epic_id = ?`
   (embedded tasks vanish with the row). Both advance the cursor.

### Investigation targets

**Required** (read before coding):
- src/plan-worker.ts:266-300 — `PlanScanner` change-gate (`lastEmitted`, `seed`, `onDelete` at :293)
- src/plan-worker.ts:399-413 — `buildTaskMessage` (the shape `lastEmitted` holds, to recover `epicId`)
- src/daemon.ts:294 — `planWorker.onmessage`; how `plan-epic`/`plan-task` become synthetic events (the pattern to extend)
- src/reducer.ts:233-287 (projectPlanRow, now array-based after task 1), :441-451 (applyEvent routing)

**Optional** (reference as needed):
- src/reducer.ts:177-213 — PlanSnapshot / extractPlanSnapshot (blob parse pattern for the TaskDeleted epic_id)

### Risks

- Replay determinism: a TaskSnapshot followed by a TaskDeleted must re-fold to the spliced-out state regardless of arrival order; an EpicDeleted followed by a later TaskSnapshot legitimately re-creates a shell (the task still exists on disk). Extend the re-fold determinism test to cover a create→delete sequence.
- Recovering `epicId` from `lastEmitted` depends on `seedFromDb` having warmed the gate on boot (it does, after task 1) — confirm a delete shortly after restart still resolves the parent.

### Test notes

- Plan-worker: assert `onDelete` emits the correct tombstone message with recovered `epicId`, and nothing when un-seeded.
- Reducer: fold `TaskDeleted` → element gone + epic `last_event_id` bumped; `EpicDeleted` → epic row gone; both idempotent on a missing target; re-fold determinism across create→delete.
- Integration: write then delete a task file under a running daemon, assert the parent epic `patch`es with the element removed; delete an epic file, assert the epic row leaves the `epics` page.

## Acceptance

- [ ] deleting a task file emits `plan-task-deleted` (with recovered `epicId`) → synthetic `TaskDeleted` → element spliced from the parent epic array, epic `patch`es
- [ ] deleting an epic file emits `plan-epic-deleted` → synthetic `EpicDeleted` → epic row deleted
- [ ] both folds are idempotent (missing target = no-op) and advance the cursor; main stays sole synthetic writer
- [ ] re-fold determinism holds across create→delete sequences; suite green

## Done summary

## Evidence
