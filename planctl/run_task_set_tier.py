"""planctl task set-tier — persist the worker reasoning tier on a task (fn-405).

Sets ``tier`` on the task-definition JSON to one of
``medium | high | xhigh | max``. Used by `/plan:work` Phase 3c after the
orchestrator picks a tier so cross-session cold-resume can re-read it instead
of re-deriving via the Phase 3c heuristic (which defaults-in-doubt to xhigh
and would silently bump a deliberate `medium` choice).

NOT in ``VALIDATION_RESTAMP_VERBS`` — runtime detail, not validation-relevant
structure.
"""

from __future__ import annotations

from types import SimpleNamespace


def run(args: SimpleNamespace) -> int:
    from planctl.ids import is_task_id
    from planctl.models import TASK_TIERS, normalize_task
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.store import atomic_write_json, load_json, now_iso

    task_id: str = args.task_id
    tier: str = args.tier

    if not is_task_id(task_id):
        emit_error(f"Invalid task ID: {task_id}")

    if tier not in TASK_TIERS:
        emit_error(f"Invalid tier: {tier!r}. Must be one of: {', '.join(TASK_TIERS)}")

    ctx = resolve_project()
    data_dir = ctx.data_dir

    task_path = data_dir / "tasks" / f"{task_id}.json"
    if not task_path.exists():
        emit_error(f"Task not found: {task_id}")

    task_def = normalize_task(load_json(task_path))

    now = now_iso()
    task_def["tier"] = tier
    task_def["updated_at"] = now
    atomic_write_json(task_path, task_def)

    # fn-629 task .3: route through the central seam. Rewrite of a
    # pre-existing tracked file (atomic_write rename-atomic) → no unwind.
    emit(
        {
            "task_id": task_id,
            "tier": tier,
        },
        verb="task-set-tier",
        target=task_id,
        repo_root=ctx.project_path,
        written_paths=[],
    )
    return 0
