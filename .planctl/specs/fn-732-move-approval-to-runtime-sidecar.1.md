## Description

**Size:** M
**Files:** planctl/store.py, planctl/run_approve.py, planctl/models.py, planctl/api.py, planctl/CLAUDE.md, planctl/README.md, planctl/docs/reference/commit-at-mutation-boundary.md, tests/test_run_approve.py, tests/test_models.py

Move the planctl-side write and all reads of `approval` from the tracked
def files to the gitignored sidecars per the epic's Sidecar contract.

### Approach

- **Store (`store.py`):** generalize `LocalFileStateStore` — add an
  `epics_dir` (`.planctl/state/epics/`) plus `save_epic_runtime` /
  `load_epic_runtime` / `_epic_state_path` mirroring the task methods, and
  an epic lock mirroring `lock_task`. Reuse `atomic_write_json` (sorted,
  fsync, rename). Read-never-creates (absent → None), per `acks.py`.
- **Write (`run_approve.py`):** task branch → read-modify-write the task
  sidecar under `lock_task` (load runtime, set `approval` + `updated_at`,
  save) so a concurrent `status` write is preserved — NOT a blind replace.
  Epic branch → write the new epic sidecar. Stop writing
  `approval`/`updated_at` to the def file. Keep the `emit(verb="approve")`
  seam but reclassify `approve` as runtime-state-only (no auto-commit) —
  mirror `claim`/`block`.
- **Gates (`run_approve.py`):** `_gate_task_approve` and
  `_gate_epic_approve` (the `task_def.get("approval")` read at ~:220) must
  read the MERGED approval via the resolution ladder, not the def field —
  otherwise every epic-approve refuses.
- **Merge/normalize (`models.py`):** move the `approval="pending"` default
  OUT of `normalize_task`/`normalize_epic` (currently ~:127/:201) INTO a
  merge step. Extend `merge_task_state` to carry merged `approval`
  (sidecar wins → def fallback → pending); add `merge_epic_state`.
- **Readers (`api.py`):** `load_epic` / `load_tasks_for_epic` and every
  approval consumer (`run_claim`, `run_block`, `integrity`, `run_done`,
  `run_epic_rm`) read merged approval via the same ladder.
- **Docs:** planctl `CLAUDE.md` (approve joins the `claim`/`block`
  runtime-state-only class), `README.md` (add `state/epics/{id}.state.json`
  to the file tree; revise the gitignore note to name approval),
  `docs/reference/commit-at-mutation-boundary.md` (move `approve` from the
  mutating-single-field auto-commit row to the runtime-state-only no-commit
  row; remove `chore(planctl): approve` commit-subject examples).

### Investigation targets

**Required** (read before coding):
- planctl/store.py:141-196 — `LocalFileStateStore` (the class to generalize)
- planctl/run_approve.py:159-340 — both gates + both write branches (:220 epic-gate read; :283-285/:322-324 def writes)
- planctl/models.py:206-215 — `merge_task_state` fusion pattern; :46-/:142- `normalize_epic`/`normalize_task` (the pending default to move)
- planctl/acks.py — gitignored-state read-never-creates discipline
- planctl/docs/reference/commit-at-mutation-boundary.md — verb classification table + subject/trailer §5

**Optional:**
- planctl/api.py — `load_epic` / `load_tasks_for_epic` merge seam
- tests/test_run_approve.py, tests/test_models.py, tests/test_acks_module.py — test templates

### Risks

- Two writers on the task sidecar — RMW-under-lock is mandatory or
  `claim`/`approve` races drop a field.
- Missing any one reader of `approval` leaves it reading the (soon-empty)
  def field → stale `pending`. Grep all `["']approval["']` reads.
- The pending-default must live in EXACTLY one place (the merge) — leaving
  it in normalize too yields stale `pending` overriding the sidecar.

### Test notes

pytest: approve writes sidecar (task RMW preserves status; epic sidecar
created); def file carries no approval after approve; both gates read
merged approval (epic-approve succeeds when task approval is in sidecar);
`merge_epic_state` precedence (sidecar > def > pending); approve does not
auto-commit.

## Acceptance

- [ ] `planctl approve` writes the sidecar (task: RMW under lock; epic: new sidecar) and no longer mutates the def file.
- [ ] `_gate_task_approve` + `_gate_epic_approve` and all `api.py` readers resolve approval via the ladder (sidecar > def > pending).
- [ ] `approval="pending"` default lives only in the merge step, not in `normalize_*`.
- [ ] `approve` is reclassified runtime-state-only (no auto-commit); docs updated to match.
- [ ] pytest green incl. new sidecar + merge + concurrent-writer cases.

## Done summary
Moved planctl approval off the tracked def files into gitignored runtime sidecars: approve RMW-writes the task sidecar under lock_task (preserving a concurrent status write) and writes a new epic sidecar, reclassified runtime-state-only (no auto-commit). The pending-default and sidecar>def>pending ladder now live only in merge_task_state/merge_epic_state; normalize_* no longer defaults approval; load_epic merges the epic sidecar and the epic gate reads merged approval.
## Evidence
