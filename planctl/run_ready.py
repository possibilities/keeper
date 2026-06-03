"""planctl ready - List tasks that are ready to be worked on."""

from __future__ import annotations

from types import SimpleNamespace


def _render_human(data: dict) -> str:
    epic_id = data.get("epic", "")
    actor = data.get("actor", "")
    ready = data.get("ready", [])
    in_progress = data.get("in_progress", [])
    blocked = data.get("blocked", [])

    lines = [f"Epic: {epic_id}"]
    if ready:
        lines.append("\nReady:")
        for t in ready:
            lines.append(f"  {t['id']}  {t.get('title', '')}")
    if in_progress:
        lines.append("\nIn Progress:")
        for t in in_progress:
            you = " (you)" if t.get("assignee") == actor else ""
            assignee = t.get("assignee", "")
            lines.append(f"  {t['id']}  {t.get('title', '')} {assignee}{you}")
    if blocked:
        lines.append("\nBlocked:")
        for t in blocked:
            bb = t.get("blocked_by", [])
            suffix = f"\n    blocked by: {', '.join(bb)}" if bb else ""
            lines.append(f"  {t['id']}  {t.get('title', '')}{suffix}")
    if not ready and not in_progress and not blocked:
        lines.append("\nNo tasks.")
    return "\n".join(lines)


def run(args: SimpleNamespace) -> int:
    from planctl.ids import parse_id
    from planctl.models import merge_task_state, task_priority
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.store import LocalFileStateStore, get_actor, load_json_safe

    epic_id: str = args.epic_id

    ctx = resolve_project()
    data_dir = ctx.data_dir
    state_store = LocalFileStateStore(ctx.state_dir)
    actor = get_actor()

    epic_path = data_dir / "epics" / f"{epic_id}.json"
    if not epic_path.exists():
        emit_error(f"Epic not found: {epic_id}")

    # Load all tasks for this epic
    tasks_dir = data_dir / "tasks"
    all_tasks: dict[str, dict] = {}
    if tasks_dir.exists():
        for f in tasks_dir.glob(f"{epic_id}.*.json"):
            td = load_json_safe(f)
            if td:
                tid = td.get("id", f.stem)
                runtime = state_store.load_runtime(tid)
                merged = merge_task_state(td, runtime)
                all_tasks[tid] = merged

    ready: list[dict] = []
    in_progress: list[dict] = []
    blocked: list[dict] = []

    for _tid, t in all_tasks.items():
        status = t.get("status", "todo")

        if status == "in_progress":
            in_progress.append(t)
        elif status == "blocked":
            blocked.append(t)
        elif status == "todo":
            # Check if deps are met
            deps = t.get("depends_on", [])
            unmet = [d for d in deps if all_tasks.get(d, {}).get("status") != "done"]
            if unmet:
                t["_blocked_by"] = unmet
                blocked.append(t)
            else:
                ready.append(t)

    def sort_key(t):
        _, tn = parse_id(t.get("id", ""))
        return (task_priority(t), tn or 999, t.get("title", ""))

    ready.sort(key=sort_key)
    in_progress.sort(key=sort_key)
    blocked.sort(key=sort_key)

    emit(
        {
            "epic": epic_id,
            "actor": actor,
            "ready": [
                {
                    "id": t["id"],
                    "title": t.get("title", ""),
                    "priority": t.get("priority"),
                    "depends_on": t.get("depends_on", []),
                }
                for t in ready
            ],
            "in_progress": [
                {
                    "id": t["id"],
                    "title": t.get("title", ""),
                    "assignee": t.get("assignee"),
                    "priority": t.get("priority"),
                }
                for t in in_progress
            ],
            "blocked": [
                {
                    "id": t["id"],
                    "title": t.get("title", ""),
                    "blocked_by": t.get("_blocked_by", []),
                }
                for t in blocked
            ],
        },
        text_renderer=_render_human,
    )
    return 0
