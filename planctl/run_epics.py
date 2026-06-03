"""planctl epics - List all epics."""

from __future__ import annotations

from types import SimpleNamespace


def _render_human(data: dict) -> str:
    """Render the epics envelope as a table text view."""
    lines = []
    for re_ in data.get("epics", []):
        s = re_["task_summary"]
        parts = []
        for k in ["todo", "in_progress", "done", "blocked"]:
            if s[k] > 0:
                parts.append(f"{s[k]} {k}")
        task_str = (
            f"{s['total']} tasks ({', '.join(parts)})"
            if parts
            else f"{s['total']} tasks"
        )
        lines.append(f"{re_['id']}  {re_['title']}  [{re_['status']}]  {task_str}")
    return "\n".join(lines)


def run(args: SimpleNamespace) -> int:
    from planctl.ids import parse_id
    from planctl.models import merge_task_state
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
                epics.append(ed)

    # Sort by epic number
    def sort_key(e):
        en, _ = parse_id(e.get("id", ""))
        return en or 999

    epics.sort(key=sort_key)

    # Count tasks per epic
    tasks_dir = data_dir / "tasks"
    result_epics: list[dict] = []
    for e in epics:
        eid = e.get("id", "")
        summary = {"total": 0, "todo": 0, "in_progress": 0, "done": 0, "blocked": 0}
        if tasks_dir.exists():
            for f in tasks_dir.glob(f"{eid}.*.json"):
                td = load_json_safe(f)
                if td:
                    tid = td.get("id", f.stem)
                    runtime = state_store.load_runtime(tid)
                    merged = merge_task_state(td, runtime)
                    summary["total"] += 1
                    s = merged.get("status", "todo")
                    if s in summary:
                        summary[s] += 1

        result_epics.append(
            {
                "id": eid,
                "title": e.get("title", ""),
                "status": e.get("status", "open"),
                "branch_name": e.get("branch_name"),
                "task_summary": summary,
            }
        )

    emit({"epics": result_epics}, text_renderer=_render_human)
    return 0
