"""planctl epic set-branch - Set the branch name on an epic."""

from __future__ import annotations

from types import SimpleNamespace


def _render_human(data: dict) -> str:
    return f"Set branch for {data.get('epic_id')}: {data.get('branch_name')}"


def run(args: SimpleNamespace) -> int:
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.store import atomic_write_json, load_json, now_iso

    epic_id: str = args.epic_id
    branch: str = args.branch
    ctx = resolve_project()
    data_dir = ctx.data_dir

    epic_path = data_dir / "epics" / f"{epic_id}.json"
    if not epic_path.exists():
        emit_error(f"Epic not found: {epic_id}")

    epic_def = load_json(epic_path)
    epic_def["branch_name"] = branch
    epic_def["updated_at"] = now_iso()
    atomic_write_json(epic_path, epic_def)

    # Route through the central seam at output.emit() so the invocation-build
    # + commit run inside the verb boundary. The write is a rewrite of a
    # pre-existing tracked JSON file via atomic_write (rename-atomic), so a
    # pre-commit raise leaves the prior valid contents in place.
    emit(
        {"epic_id": epic_id, "branch_name": branch},
        text_renderer=_render_human,
        verb="set-branch",
        target=epic_id,
        repo_root=ctx.project_path,
    )
    return 0
