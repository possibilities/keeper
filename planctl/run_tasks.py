"""planctl tasks - List tasks with optional filtering."""

from __future__ import annotations

from types import SimpleNamespace


def _render_human(data: dict) -> str:
    lines: list[str] = []
    for t in data.get("tasks", []):
        assignee = t.get("assignee", "")
        assignee_str = f"  {assignee}" if assignee else ""
        lines.append(
            f"{t.get('id')}  {t.get('title', '')}  [{t.get('status', 'todo')}]{assignee_str}"
        )
    return "\n".join(lines)


def run(args: SimpleNamespace) -> int:
    from planctl.ids import parse_id
    from planctl.models import merge_task_state
    from planctl.output import emit
    from planctl.project import resolve_project
    from planctl.store import LocalFileStateStore, load_json_safe

    epic_id: str | None = args.epic_id
    status_filter: str | None = args.status

    ctx = resolve_project()
    data_dir = ctx.data_dir
    state_store = LocalFileStateStore(ctx.state_dir)

    tasks_dir = data_dir / "tasks"
    all_tasks: list[dict] = []

    if tasks_dir.exists():
        pattern = f"{epic_id}.*.json" if epic_id else "*.json"
        for f in tasks_dir.glob(pattern):
            td = load_json_safe(f)
            if td:
                tid = td.get("id", f.stem)
                runtime = state_store.load_runtime(tid)
                merged = merge_task_state(td, runtime)
                all_tasks.append(merged)

    # Apply status filter
    if status_filter:
        all_tasks = [t for t in all_tasks if t.get("status") == status_filter]

    # Sort by (epic_number, task_number)
    def sort_key(t):
        en, tn = parse_id(t.get("id", ""))
        return (en or 999, tn or 999)

    all_tasks.sort(key=sort_key)

    emit(
        {
            "tasks": [
                {
                    "id": t.get("id"),
                    "epic": t.get("epic"),
                    "title": t.get("title"),
                    "status": t.get("status", "todo"),
                    "priority": t.get("priority"),
                    "assignee": t.get("assignee"),
                }
                for t in all_tasks
            ],
        },
        text_renderer=_render_human,
    )
    return 0
