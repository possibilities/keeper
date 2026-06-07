## Overview

Move planctl `approval` out of the git-tracked def files
(`.planctl/{tasks,epics}/<id>.json`) into gitignored runtime sidecars so
keeper's plan-worker folds it **gate-free** — eliminating the autopilot's
tens-of-seconds lag reacting to `/approve` completions. Today `status`
rides the gitignored `.planctl/state/tasks/<id>.state.json` sidecar, which
keeper's `task-state` fold arm projects immediately (bypassing the fn-629
in-HEAD observation gate). `approval` lives only in the tracked def file,
held behind that gate until keeperd observes the approve commit — the
slow/racy path. Full symmetric move across BOTH tasks and epics; approval
leaves git history entirely (lives only in the sidecar + keeper's event
log — confirmed wanted out of git).

Root cause confirmed against the live system: the autopilot reconciler
dispatches the next action in the SAME second the approval folds; the
entire delay is fold latency, not reconcile latency.

## Sidecar contract (BOTH repos MUST agree byte-for-byte)

- **Task sidecar** — existing `.planctl/state/tasks/<task_id>.state.json`
  gains an `"approval"` key alongside `"status"`. Two writers now share this
  file (`claim`/`block` write `status`, `approve` writes `approval`), so the
  approve write MUST be read-modify-write under `lock_task` — never a blind
  full-object replace, or it clobbers a concurrent status write.
- **Epic sidecar** — NEW `.planctl/state/epics/<epic_id>.state.json`,
  `{ "approval": "...", "updated_at": "..." }`. Single writer.
- **Resolution ladder (every reader, both repos, identical):** valid
  sidecar `approval` wins → on sidecar absent / no `approval` key /
  parse-fail, fall back to the def-file `approval` → absent everywhere →
  `"pending"`. (The def-fallback is the cutover safety net; after the
  backfill strips def approval it inertly yields `pending`.)
- **keeper determinism:** the sidecar is read PRODUCER-side (plan-worker
  cache), threaded into the snapshot event; the reducer is unchanged and
  folds `snapshot.approval` from the event blob. Re-fold stays
  byte-identical (events are self-contained; object-literal key order in
  `buildTaskMessage`/`buildEpicMessage` is load-bearing for the change-gate).
- `.planctl/state/` is already gitignored in both repos — no gitignore edit.
- **No schema bump** — the `approval` column already exists (v13); only its
  source path moves. Do not touch `SCHEMA_VERSION` /
  `SUPPORTED_SCHEMA_VERSIONS` unless the snapshot blob shape actually changes.

## Quick commands

- `cd ~/code/planctl && uv run pytest tests/test_run_approve.py tests/test_models.py -q`
- `cd ~/code/keeper && bun test test/plan-worker.test.ts test/plan-classifier.test.ts test/rpc-handlers.test.ts`
- End-to-end smoke (post-cutover): approve a done task, confirm keeper folds
  `approval=approved` within ~1s (no commit, no 60s wait) —
  `keeper` board / readiness shows the row `completed` promptly.

## Cutover (serialized / quiesced — no staged dual-read window)

Processing is linear/serialized, so cut over while no epic is in flight:
1. Land all four tasks in both repos.
2. Run the one-shot backfill (task .2) per repo: seeds sidecars from
   existing def `approval` AND strips `approval` from def files.
3. Restart keeperd. The keeper def-fallback makes step-2-vs-3 ordering
   non-fatal (if keeper boots first it reads the still-present def approval
   instead of resetting historical approvals to `pending`).

## Acceptance

- [ ] `/plan:approve` of a done task/epic folds into keeper's projection
      within ~1s (gate-free), with no `chore(planctl): approve` commit.
- [ ] Approval is absent from all tracked def files after cutover; it lives
      only in the sidecars + keeper's event log.
- [ ] Existing historical approvals are NOT reset to `pending` at cutover
      (backfill + def-fallback).
- [ ] Concurrent `claim`/`block` (status) and `approve` (approval) on the
      same task sidecar do not clobber each other.
- [ ] keeper re-fold from empty reproduces byte-identical rows.
- [ ] Both test suites green; invariant docs updated to match.

## Early proof point

Task that proves the approach: `.3` (keeper sidecar fold arms) — a unit test
showing the new `epic-state` arm + task approval source fold `approval`
gate-free (no in-HEAD gate on the sidecar path) is the keystone. If it
fails: the per-id `.state.json` shape isn't foldable as assumed — fall back
to having `planctl approve` ALSO emit a keeperd RPC kick (option A from the
investigation) rather than relying on the sidecar watch.

## References

- planctl precedent: `scripts/migrate_acks_to_state.py` (fn-488 moved
  `closer_acked_at`/`worker_acked_at` off tracked JSON) — the backfill
  template; `planctl/acks.py` (gitignored-state read discipline).
- keeper precedent: the `task-state` fold arm in `src/plan-worker.ts`
  (`classifyPlanPath`, `reemitTaskFromDef`, `runtimeStatusCache`,
  `scanPlanctlDir` boot-prime) — the epic-state arm mirrors it.
- fn-629 (in-HEAD observation gate), fn-701 (approval kick — becomes dead),
  fn-488 (acks gitignored-state move).
