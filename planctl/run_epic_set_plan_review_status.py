"""planctl epic set-plan-review-status - Set the plan review status on an epic."""

from __future__ import annotations

from types import SimpleNamespace

VALID_STATUSES = ("ship", "needs_work", "unknown")


def _render_human(data: dict) -> str:
    return (
        f"Set plan review status for {data.get('epic_id')}: "
        f"{data.get('plan_review_status')}"
    )


def run(args: SimpleNamespace) -> int:
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.store import atomic_write_json, load_json, now_iso

    epic_id: str = args.epic_id
    status: str = args.status

    if status not in VALID_STATUSES:
        emit_error(
            f"Invalid status {status!r}. Must be one of: {', '.join(VALID_STATUSES)}"
        )

    ctx = resolve_project()
    data_dir = ctx.data_dir

    epic_path = data_dir / "epics" / f"{epic_id}.json"
    if not epic_path.exists():
        emit_error(f"Epic not found: {epic_id}")

    epic_def = load_json(epic_path)
    reviewed_at = now_iso()
    epic_def["plan_review_status"] = status
    epic_def["plan_reviewed_at"] = reviewed_at
    epic_def["updated_at"] = now_iso()
    atomic_write_json(epic_path, epic_def)

    # fn-629 task .3: route through the central seam. Rewrite of a
    # pre-existing tracked file (atomic_write rename-atomic) → no unwind.
    emit(
        {
            "epic_id": epic_id,
            "plan_review_status": status,
            "plan_reviewed_at": reviewed_at,
        },
        text_renderer=_render_human,
        verb="set-plan-review-status",
        target=epic_id,
        detail=status,
        repo_root=ctx.project_path,
        written_paths=[],
    )
    return 0
