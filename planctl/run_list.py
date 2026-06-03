"""planctl list - List all epics and their tasks in a tree view."""

from __future__ import annotations

from types import SimpleNamespace


def _render_human(data: dict) -> str:
    """Render the list envelope as a tree text view."""
    lines = []
    epics = data.get("epics", [])
    for i, e in enumerate(epics):
        lines.append(f"{e['id']}  {e['title']}  [{e['status']}]")
        for t in e["tasks"]:
            task_id = t["id"]
            suffix = task_id.rsplit(".", 1)[-1] if "." in task_id else task_id
            assignee = f"  {t['assignee']}" if t.get("assignee") else ""
            lines.append(f"  .{suffix}  {t['title']}  [{t['status']}]{assignee}")
        if i < len(epics) - 1:
            lines.append("")
    return "\n".join(lines)


def run(args: SimpleNamespace) -> int:
    from planctl.ids import parse_id
    from planctl.models import merge_task_state, normalize_epic
    from planctl.output import emit
    from planctl.project import resolve_project
    from planctl.store import LocalFileStateStore, load_json_safe

    ctx = resolve_project()
    data_dir = ctx.data_dir
    state_store = LocalFileStateStore(ctx.state_dir)

    epics_dir = data_dir / "epics"
    epics: list[dict] = []
    if epics_dir.exists():
        for f in epics_dir.glob("*.json"):
            ed = load_json_safe(f)
            if ed:
                epics.append(normalize_epic(ed))

    # Sort epics by number
    def epic_sort(e):
        en, _ = parse_id(e.get("id", ""))
        return en or 999

    epics.sort(key=epic_sort)

    tasks_dir = data_dir / "tasks"
    result: list[dict] = []

    for e in epics:
        eid = e.get("id", "")
        epic_tasks: list[dict] = []

        if tasks_dir.exists():
            for f in tasks_dir.glob(f"{eid}.*.json"):
                td = load_json_safe(f)
                if td:
                    tid = td.get("id", f.stem)
                    runtime = state_store.load_runtime(tid)
                    merged = merge_task_state(td, runtime)
                    epic_tasks.append(merged)

        # Sort tasks by number
        def task_sort(t):
            _, tn = parse_id(t.get("id", ""))
            return tn or 999

        epic_tasks.sort(key=task_sort)

        result.append(
            {
                "id": eid,
                "title": e.get("title", ""),
                "status": e.get("status", "open"),
                "tasks": [
                    {
                        "id": t.get("id"),
                        "title": t.get("title", ""),
                        "status": t.get("status", "todo"),
                        "assignee": t.get("assignee"),
                    }
                    for t in epic_tasks
                ],
            }
        )

    emit({"epics": result}, text_renderer=_render_human)
    return 0
