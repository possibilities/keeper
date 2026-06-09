## Description

**Size:** M
**Files:** planctl/run_approve.py (delete), planctl/run_render_approve_context.py (delete), planctl/run_task_ack.py (delete), planctl/run_epic_ack.py (delete), planctl/acks.py (delete), scripts/migrate_approval_to_sidecar.py (delete), skills/approve/ (delete), planctl/runtime_status.py, planctl/models.py, planctl/store.py, planctl/integrity.py, planctl/cli.py, planctl/run_done.py, planctl/run_epic_close.py, planctl/run_task_reset.py, planctl/run_epic_rm.py, planctl/commit_messages.py, skills/close/SKILL.md, README.md, CLAUDE.md, tests/* (test_run_approve, test_render_approve_context, test_runtime_status, test_migrate_approval_to_sidecar, test_models, test_global_state, test_epic_close)

### Approach

Remove BOTH gates planctl owns. Gate B (approval enum): delete `run_approve.py`,
`run_render_approve_context.py`, `skills/approve/`, `scripts/migrate_approval_to_sidecar.py`;
drop `APPROVAL_STATUSES` and the approval merge/normalize ladder from
`models.py` (merge_task_state/merge_epic_state); drop
`read/write_{task,epic}_approval` from `store.py`; drop the approval enum
check from `integrity.py`; drop the `approve` + `render-approve-context`
subcommands from `cli.py`. Gate A (ack pipeline): delete `run_task_ack.py`,
`run_epic_ack.py`, `acks.py`; collapse `runtime_status.py` so
`RuntimeStatus` is `Literal["complete", "untouched"]` and a done task/epic
derives `complete` directly (delete `_task_pending_approval`,
`_epic_pending_approval`, and every `pending_approval` branch); drop the
`task ack`/`epic ack` subcommands from `cli.py`.

KEEP `worker_done_at` stamping in `run_done.py` (:143) and `closer_done_at`
in `run_epic_close.py` — they remain the keeper-fold completion signal.
Remove the now-orphaned ack-row cleanup from `run_task_reset.py` (:83 keeps
clearing `worker_done_at`; drop the acks-table drop) and `run_epic_rm.py`,
and the `pending_approval`/ack comments in `run_done.py`/`run_epic_close.py`/
`commit_messages.py`. Trim `skills/close/SKILL.md` so a closed epic is
terminal (`closed`) with no `pending_approval` flip.

This task must NOT land before keeper `.1` is deployed (dep `← .1`) — the
stall landmine. It is parallel-safe with keeper `.2` (different repo).

### Investigation targets

**Required** (read before coding):
- planctl/runtime_status.py:24-65, :85-181 — pending_approval derivation + RuntimeStatus literal to collapse
- planctl/models.py:29-36 (APPROVAL_STATUSES), :206-244 (merge ladder) — approval removal points
- planctl/cli.py:879-898 (render-approve-context), :969-1013 (approve), :212-214 (ack subcommands)
- planctl/store.py:195-262 — read/write_{task,epic}_approval
- planctl/run_done.py:139-143, planctl/run_epic_close.py:63-64 — KEEP worker_done_at/closer_done_at, drop pending_approval comments

**Optional** (reference as needed):
- planctl/integrity.py:154-183, :297-304 — approval enum checks
- planctl/run_task_reset.py:75-83, planctl/run_epic_rm.py — ack-row cleanup to drop
- skills/close/SKILL.md:~398 — pending_approval flip note

### Risks

- `runtime_status.py` is consumed by the planctl board/global_state and folded by keeper as `runtime_status`. Collapsing it to `complete|untouched` must keep a done task rendering `complete` (not a stuck `pending_approval`) — verify global_state + board tests.
- Removing `acks.py` must not leave a dangling import; grep all importers first.
- `cli.py` is the InvocationTrackedGroup — removing subcommands must not break the tracked-verb fallback gate or `_NO_TRACK_COMMANDS` (drop `render-approve-context` from that set too, :19).

### Test notes

Delete test_run_approve.py, test_render_approve_context.py, test_migrate_approval_to_sidecar.py. Rewrite test_runtime_status.py to the two-state model (no pending_approval). Trim approval cases from test_models.py, test_global_state.py, test_epic_close.py. `uv run pytest` green.

## Acceptance

- [ ] `approve`, `render-approve-context`, `task ack`, `epic ack` removed from `planctl --help`; the runner modules + `acks.py` + `skills/approve/` + `migrate_approval_to_sidecar.py` deleted.
- [ ] `RuntimeStatus` is `Literal["complete", "untouched"]`; a `status=="done"` task/epic derives `complete`; no `pending_approval` path remains.
- [ ] `APPROVAL_STATUSES` and the approval merge/normalize ladder gone from `models.py`; no `read/write_*_approval` in `store.py`; no approval enum check in `integrity.py`.
- [ ] `worker_done_at`/`closer_done_at` still stamped on `task done`/`epic close`; no orphaned consumer.
- [ ] README.md/CLAUDE.md carry no approval/ack prose (present-tense, no tombstones); `approve` dropped from the runtime-state-only verb list.
- [ ] `uv run pytest` green.

## Done summary

## Evidence
