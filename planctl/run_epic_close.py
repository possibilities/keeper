"""planctl epic close - Mark an epic as done."""

from __future__ import annotations

from types import SimpleNamespace


def run(args: SimpleNamespace) -> int:
    from planctl.models import merge_task_state
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.store import (
        LocalFileStateStore,
        atomic_write_json,
        load_json,
        load_json_safe,
        now_iso,
    )

    epic_id: str = args.epic_id
    force: bool = args.force
    close_reason: str | None = getattr(args, "reason", None)
    ctx = resolve_project()
    data_dir = ctx.data_dir
    state_store = LocalFileStateStore(ctx.state_dir)

    epic_path = data_dir / "epics" / f"{epic_id}.json"
    if not epic_path.exists():
        emit_error(f"Epic not found: {epic_id}")

    epic_def = load_json(epic_path)
    if epic_def.get("status") == "done":
        emit_error(f"Epic {epic_id} is already done")

    # Load tasks
    tasks_dir = data_dir / "tasks"
    tasks_done = 0
    tasks_total = 0
    not_done: list[str] = []

    if tasks_dir.exists():
        for f in tasks_dir.glob(f"{epic_id}.*.json"):
            task_def = load_json_safe(f)
            if task_def:
                tasks_total += 1
                tid = task_def.get("id", f.stem)
                runtime = state_store.load_runtime(tid)
                merged = merge_task_state(task_def, runtime)
                if merged.get("status") == "done":
                    tasks_done += 1
                else:
                    not_done.append(f"{tid} ({merged.get('status', 'todo')})")

    if not force and not_done:
        msg = f"Cannot close {epic_id}: {len(not_done)} task(s) not done: {', '.join(not_done)}"
        emit_error(msg)

    now = now_iso()
    epic_def["status"] = "done"
    epic_def["updated_at"] = now
    # Stamp closer_done_at on the tracked epic definition. This is the
    # completion signal keeper folds at the epic level: a closed epic with
    # closer_done_at set is complete.
    epic_def["closer_done_at"] = now
    if close_reason is not None:
        epic_def["close_reason"] = close_reason
    atomic_write_json(epic_path, epic_def)

    # Route through the central seam. Rewrite of a
    # pre-existing tracked file (atomic_write rename-atomic) → no unwind.
    emit(
        {
            "epic_id": epic_id,
            "status": "done",
            "tasks_done": tasks_done,
            "tasks_total": tasks_total,
            "close_reason": close_reason,
        },
        verb="close",
        target=epic_id,
        repo_root=ctx.project_path,
    )
    return 0
