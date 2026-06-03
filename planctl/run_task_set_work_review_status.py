"""planctl task set-work-review-status - Set the work review status on a task."""

from __future__ import annotations

from types import SimpleNamespace

VALID_STATUSES = ("ship", "needs_work", "unknown")


def _render_human(data: dict) -> str:
    return (
        f"Set work review status for {data.get('task_id')}: "
        f"{data.get('work_review_status')}"
    )


def run(args: SimpleNamespace) -> int:
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.store import atomic_write_json, load_json, now_iso

    task_id: str = args.task_id
    status: str = args.status

    if status not in VALID_STATUSES:
        emit_error(
            f"Invalid status {status!r}. Must be one of: {', '.join(VALID_STATUSES)}"
        )

    ctx = resolve_project()
    data_dir = ctx.data_dir

    task_path = data_dir / "tasks" / f"{task_id}.json"
    if not task_path.exists():
        emit_error(f"Task not found: {task_id}")

    task_def = load_json(task_path)
    reviewed_at = now_iso()
    task_def["work_review_status"] = status
    task_def["work_reviewed_at"] = reviewed_at
    task_def["updated_at"] = now_iso()
    atomic_write_json(task_path, task_def)

    # fn-629 task .3: route through the central seam. Rewrite of a
    # pre-existing tracked file (atomic_write rename-atomic) → no unwind.
    emit(
        {
            "task_id": task_id,
            "work_review_status": status,
            "work_reviewed_at": reviewed_at,
        },
        text_renderer=_render_human,
        verb="task-set-work-review-status",
        target=task_id,
        detail=status,
        repo_root=ctx.project_path,
        written_paths=[],
    )
    return 0
