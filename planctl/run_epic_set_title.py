"""planctl epic set-title - Rename an epic (ID remains unchanged)."""

from __future__ import annotations

from types import SimpleNamespace


def _render_human(data: dict) -> str:
    return f"Renamed {data.get('epic_id')}: {data.get('title')}"


def run(args: SimpleNamespace) -> int:
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.store import atomic_write_json, load_json, now_iso

    epic_id: str = args.epic_id
    title: str = args.title

    ctx = resolve_project()
    data_dir = ctx.data_dir

    epic_path = data_dir / "epics" / f"{epic_id}.json"
    if not epic_path.exists():
        emit_error(f"Epic not found: {epic_id}")

    epic_def = load_json(epic_path)
    epic_def["title"] = title
    epic_def["updated_at"] = now_iso()
    atomic_write_json(epic_path, epic_def)

    # Route through the central seam. Rewrite of a
    # pre-existing tracked file (atomic_write rename-atomic) → no unwind.
    emit(
        {"epic_id": epic_id, "title": title},
        text_renderer=_render_human,
        verb="set-title",
        target=epic_id,
        repo_root=ctx.project_path,
    )
    return 0
