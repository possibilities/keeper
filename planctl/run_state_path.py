"""planctl state-path - Print the resolved state directory path."""

from __future__ import annotations

from types import SimpleNamespace


def run(args: SimpleNamespace) -> int:
    from planctl.output import emit
    from planctl.project import resolve_project

    task_id: str | None = args.task_id

    ctx = resolve_project()
    state_dir = ctx.state_dir

    data: dict = {"state_dir": str(state_dir)}

    if task_id:
        task_state_path = state_dir / "tasks" / f"{task_id}.state.json"
        data["task_state_path"] = str(task_state_path)

    emit(data)
    return 0
