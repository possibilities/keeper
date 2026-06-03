"""planctl show - Show detailed information about an epic or task."""

from __future__ import annotations

from types import SimpleNamespace


def _render_human(data: dict) -> str:
    """Render the show envelope as labeled key:value text."""
    lines = []
    typ = data.get("type")
    if typ == "task":
        t = data.get("task", {})
        lines.append(f"Task: {t.get('id')}")
        lines.append(f"Title: {t.get('title')}")
        lines.append(f"Epic: {t.get('epic')}")
        lines.append(f"Status: {t.get('status', 'todo')}")
        assignee = t.get("assignee")
        if assignee:
            claimed = t.get("claimed_at", "")
            lines.append(f"Assignee: {assignee} (claimed {claimed})")
        p = t.get("priority")
        lines.append(f"Priority: {p if p is not None else '-'}")
        deps = t.get("depends_on", [])
        lines.append(f"Dependencies: {', '.join(deps) if deps else '(none)'}")
        target_repo = t.get("target_repo")
        if target_repo:
            lines.append(f"Target repo: {target_repo}")
        snippets = t.get("snippets")
        if snippets:
            lines.append(f"Snippets: {', '.join(snippets)}")
        bundles = t.get("bundles")
        if bundles:
            lines.append(f"Bundles: {', '.join(bundles)}")
        lines.append(f"Created: {t.get('created_at', '')}")
        lines.append(f"Updated: {t.get('updated_at', '')}")
    elif typ == "epic":
        e = data.get("epic", {})
        lines.append(f"Epic: {e.get('id')}")
        lines.append(f"Title: {e.get('title')}")
        lines.append(f"Status: {e.get('status')}")
        bn = e.get("branch_name")
        if bn:
            lines.append(f"Branch: {bn}")
        deps = e.get("depends_on_epics", [])
        if deps:
            lines.append(f"Epic deps: {', '.join(deps)}")
        primary_repo = e.get("primary_repo")
        if primary_repo:
            lines.append(f"Primary repo: {primary_repo}")
        touched_repos = e.get("touched_repos")
        if touched_repos:
            lines.append(f"Touched repos: {', '.join(touched_repos)}")
        snippets = e.get("snippets")
        if snippets:
            lines.append(f"Snippets: {', '.join(snippets)}")
        bundles = e.get("bundles")
        if bundles:
            lines.append(f"Bundles: {', '.join(bundles)}")
        summary = e.get("task_summary", {})
        lines.append(
            f"Tasks: {summary.get('total', 0)} "
            f"({summary.get('todo', 0)} todo, "
            f"{summary.get('in_progress', 0)} in_progress, "
            f"{summary.get('done', 0)} done, "
            f"{summary.get('blocked', 0)} blocked)"
        )
    return "\n".join(lines)


def run(args: SimpleNamespace) -> int:
    from planctl.ids import is_epic_id, is_task_id
    from planctl.models import merge_task_state
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.store import LocalFileStateStore, load_json, load_json_safe

    id_str: str = args.id

    if is_task_id(id_str):
        ctx = resolve_project()
        data_dir = ctx.data_dir
        state_store = LocalFileStateStore(ctx.state_dir)

        task_path = data_dir / "tasks" / f"{id_str}.json"
        if not task_path.exists():
            emit_error(f"Task not found: {id_str}")

        task_def = load_json(task_path)
        runtime = state_store.load_runtime(id_str)
        merged = merge_task_state(task_def, runtime)

        emit(
            {
                "type": "task",
                "task": {
                    "id": merged.get("id"),
                    "epic": merged.get("epic"),
                    "title": merged.get("title"),
                    "priority": merged.get("priority"),
                    "depends_on": merged.get("depends_on", []),
                    "spec_path": f"specs/{id_str}.md",
                    "status": merged.get("status", "todo"),
                    "assignee": merged.get("assignee"),
                    "claimed_at": merged.get("claimed_at"),
                    "claim_note": merged.get("claim_note"),
                    "evidence": merged.get("evidence"),
                    "blocked_reason": merged.get("blocked_reason"),
                    "target_repo": merged.get("target_repo"),
                    "snippets": merged.get("snippets", []),
                    "bundles": merged.get("bundles", []),
                    "tier": merged.get("tier"),
                    "created_at": merged.get("created_at"),
                    "updated_at": merged.get("updated_at"),
                },
            },
            text_renderer=_render_human,
        )
        return 0

    elif is_epic_id(id_str):
        ctx = resolve_project()
        data_dir = ctx.data_dir
        state_store = LocalFileStateStore(ctx.state_dir)

        epic_path = data_dir / "epics" / f"{id_str}.json"
        if not epic_path.exists():
            emit_error(f"Epic not found: {id_str}")

        epic_def = load_json(epic_path)

        # Count tasks
        tasks_dir = data_dir / "tasks"
        summary = {"total": 0, "todo": 0, "in_progress": 0, "done": 0, "blocked": 0}
        if tasks_dir.exists():
            for f in tasks_dir.glob(f"{id_str}.*.json"):
                td = load_json_safe(f)
                if td:
                    tid = td.get("id", f.stem)
                    runtime = state_store.load_runtime(tid)
                    merged = merge_task_state(td, runtime)
                    summary["total"] += 1
                    s = merged.get("status", "todo")
                    if s in summary:
                        summary[s] += 1

        emit(
            {
                "type": "epic",
                "epic": {
                    "id": epic_def.get("id"),
                    "title": epic_def.get("title"),
                    "status": epic_def.get("status"),
                    "branch_name": epic_def.get("branch_name"),
                    "depends_on_epics": epic_def.get("depends_on_epics", []),
                    "spec_path": f"specs/{id_str}.md",
                    "primary_repo": epic_def.get("primary_repo"),
                    "touched_repos": epic_def.get("touched_repos"),
                    "snippets": epic_def.get("snippets", []),
                    "bundles": epic_def.get("bundles", []),
                    "created_at": epic_def.get("created_at"),
                    "updated_at": epic_def.get("updated_at"),
                    "task_summary": summary,
                },
            },
            text_renderer=_render_human,
        )
        return 0

    else:
        emit_error(f"Invalid ID format: {id_str}")
