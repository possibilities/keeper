"""planctl detect - Check if current directory is a planctl project."""

from __future__ import annotations

from types import SimpleNamespace


def run(args: SimpleNamespace) -> int:
    from planctl.output import emit
    from planctl.project import find_project_root
    from planctl.store import load_json_safe

    project_root = find_project_root()
    planctl_dir = project_root / ".planctl"

    if planctl_dir.exists():
        meta = load_json_safe(planctl_dir / "meta.json")
        schema_version = meta.get("schema_version", 0) if meta else 0

        emit(
            {
                "found": True,
                "project": {
                    "name": project_root.name,
                    "path": str(project_root),
                    "schema_version": schema_version,
                },
            }
        )
        return 0

    emit({"found": False})
    return 0
