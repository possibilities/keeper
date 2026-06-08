## Description

**Size:** M
**Files:** planctl/store.py, planctl/run_approve.py, planctl/models.py, planctl/api.py, planctl/CLAUDE.md, planctl/README.md, tests/test_run_approve.py, tests/test_models.py

**EXPAND WRITER (Phase 2) — deps: `.3`.** planctl DUAL-WRITES approval — to
the new gitignored sidecar AND the existing git-committed def file. Do NOT
stop the def write here (that is `.2`'s gated contract). Gated behind `.3`
(keeper must already read sidecar-or-def).

### Approach

- **store.py:** add sidecar read/write API (task RMW under `lock_task` to
  preserve a concurrent `status` write; new epic sidecar
  `.planctl/state/epics/<id>.state.json`), reusing `atomic_write_json`;
  read-never-creates (absent → None).
- **run_approve.py:** on approve, write the sidecar AND keep
  writing+auto-committing the def-file `approval` (DUAL-WRITE). Do NOT
  reclassify approve as runtime-state-only yet.
- **Resolution ladder (models.py/api.py):** every approval READER resolves
  sidecar → def → pending. Move the `pending` default into the merge step
  (`merge_task_state`/new `merge_epic_state`), not `normalize_*`. Gates read
  merged approval.

### Investigation targets

**Required** (read before coding):
- planctl/store.py:141-196 `LocalFileStateStore` to generalize
- planctl/run_approve.py:159-340 gates + write branches (now dual-write)
- planctl/models.py:206-215 `merge_task_state`; :46/:142 normalize (move pending default out)
- planctl/acks.py — gitignored-state read discipline

### Risks

- Two writers on the task sidecar → RMW-under-lock mandatory.
- Missing any reader of approval → stale pending; grep all `["']approval["']` reads.
- KEEP the def write — removing it here is the exact bug that black-holed approvals.

### Test notes

pytest: approve writes BOTH sidecar and def (def still carries approval +
auto-commits); task RMW preserves status; ladder resolves sidecar>def>pending.

## Acceptance

- [ ] `planctl approve` writes the sidecar AND keeps writing+committing the def-file approval (dual-write)
- [ ] all readers + gates resolve approval via sidecar>def>pending
- [ ] pending default lives only in the merge step
- [ ] approve still auto-commits (NOT reclassified yet)
- [ ] pytest green incl. dual-write + concurrent-writer + ladder cases

## Done summary
Expand-writer: planctl approve now dual-writes approval to gitignored runtime sidecars (task state file via lock_task RMW; new epic sidecar) AND keeps writing+committing the def-file approval. All readers/gates resolve approval via the sidecar>def>pending ladder; the pending default moved from normalize_* into merge_task_state/new merge_epic_state. approve still auto-commits (not reclassified).
## Evidence
