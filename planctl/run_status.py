"""planctl status - Show overall project status."""

from __future__ import annotations

from types import SimpleNamespace


def run(args: SimpleNamespace) -> int:
    from planctl.models import merge_task_state
    from planctl.output import emit
    from planctl.project import resolve_project
    from planctl.store import LocalFileStateStore, load_json_safe

    ctx = resolve_project()
    data_dir = ctx.data_dir
    state_store = LocalFileStateStore(ctx.state_dir)

    meta = load_json_safe(data_dir / "meta.json")
    schema_version = meta.get("schema_version", 1) if meta else 1

    # Count epics
    epics_dir = data_dir / "epics"
    epic_counts: dict = {"total": 0, "open": 0, "done": 0}
    if epics_dir.exists():
        for f in epics_dir.glob("*.json"):
            epic = load_json_safe(f)
            if epic:
                epic_counts["total"] += 1
                status = epic.get("status", "open")
                if status in epic_counts:
                    epic_counts[status] += 1

    # Count tasks
    tasks_dir = data_dir / "tasks"
    task_counts: dict = {
        "total": 0,
        "todo": 0,
        "in_progress": 0,
        "done": 0,
        "blocked": 0,
    }
    if tasks_dir.exists():
        for f in tasks_dir.glob("*.json"):
            task_def = load_json_safe(f)
            if task_def:
                task_id = task_def.get("id", f.stem)
                runtime = state_store.load_runtime(task_id)
                merged = merge_task_state(task_def, runtime)
                task_counts["total"] += 1
                status = merged.get("status", "todo")
                if status in task_counts:
                    task_counts[status] += 1

    emit(
        {
            "project": {
                "name": ctx.name,
                "path": str(ctx.project_path),
                "schema_version": schema_version,
            },
            "epics": epic_counts,
            "tasks": task_counts,
        }
    )
    return 0
