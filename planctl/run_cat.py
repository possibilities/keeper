"""planctl cat - Print the raw spec markdown for an epic or task."""

from __future__ import annotations

import sys
from types import SimpleNamespace


def run(args: SimpleNamespace) -> int:
    from planctl.ids import is_epic_id, is_task_id
    from planctl.project import resolve_project

    id_str: str = args.id

    if not is_epic_id(id_str) and not is_task_id(id_str):
        print(f"Error: Invalid ID format: {id_str}", file=sys.stderr)
        return 1

    ctx = resolve_project()
    data_dir = ctx.data_dir

    spec_path = data_dir / "specs" / f"{id_str}.md"
    if not spec_path.exists():
        print(f"Error: Spec not found: {spec_path}", file=sys.stderr)
        return 1

    content = spec_path.read_text(encoding="utf-8")
    sys.stdout.write(content)
    return 0
