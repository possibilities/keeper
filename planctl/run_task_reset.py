"""planctl task reset - Reset a task to todo status."""

from __future__ import annotations

from types import SimpleNamespace


def _render_human(data: dict) -> str:
    lines = [f"Reset {data.get('task_id')} to todo"]
    cr = data.get("cascade_reset") or []
    if cr:
        lines.append(f"  Also reset: {', '.join(cr)}")
    return "\n".join(lines)


def run(args: SimpleNamespace) -> int:
    from planctl import acks
    from planctl.deps import find_dependents
    from planctl.ids import epic_id_from_task
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.specs import (
        ensure_valid_task_spec,
        patch_task_section,
    )
    from planctl.store import (
        LocalFileStateStore,
        atomic_write,
        atomic_write_json,
        load_json,
        load_json_safe,
        now_iso,
    )

    task_id: str = args.task_id
    cascade: bool = args.cascade

    ctx = resolve_project()
    data_dir = ctx.data_dir
    state_store = LocalFileStateStore(ctx.state_dir)

    task_path = data_dir / "tasks" / f"{task_id}.json"
    if not task_path.exists():
        emit_error(f"Task not found: {task_id}")

    def reset_single_task(tid: str) -> None:
        """Reset a single task."""
        t_path = data_dir / "tasks" / f"{tid}.json"
        t_def = load_json(t_path)

        # Clear runtime state
        now = now_iso()
        new_state = {"status": "todo", "updated_at": now}
        with state_store.lock_task(tid):
            state_store.save_runtime(tid, new_state)

        # Clear Done summary and Evidence sections in spec
        spec_path = data_dir / "specs" / f"{tid}.md"
        if not spec_path.exists():
            emit_error(f"Spec file not found: {spec_path}")

        spec_content = spec_path.read_text(encoding="utf-8")
        try:
            ensure_valid_task_spec(spec_content)
            spec_content = patch_task_section(spec_content, "## Done summary", "")
            spec_content = patch_task_section(spec_content, "## Evidence", "")
            ensure_valid_task_spec(spec_content)
        except ValueError as e:
            emit_error(f"Task spec is malformed for {tid}: {e}")

        atomic_write(spec_path, spec_content)

        t_def["updated_at"] = now
        # fn-386: clear ack-gate fields so re-running the worker stamps a
        # fresh `worker_done_at` and the gate fires again naturally.
        # fn-488: `worker_acked_at` now lives in `.planctl/state/acks.db`
        # (gitignored), not on the tracked task JSON.  The on-disk drop
        # of `worker_done_at` still happens here; the ack row drops via
        # `acks.clear_task_ack` below.  Defensive `pop` on
        # `worker_acked_at` survives the load-from-pre-fn-488 JSON path
        # the same way `models.normalize_task` does (any stale stamp
        # gets scrubbed on the next write).
        t_def["worker_done_at"] = None
        t_def.pop("worker_acked_at", None)
        atomic_write_json(t_path, t_def)
        acks.clear_task_ack(tid, repo_root=ctx.project_path)

    # Reset the target task
    reset_single_task(task_id)

    epic_id = epic_id_from_task(task_id)

    # Cascade if requested
    cascade_reset: list[str] = []
    if cascade:
        tasks_dir = data_dir / "tasks"
        all_tasks: dict[str, dict] = {}
        if tasks_dir.exists():
            for f in tasks_dir.glob(f"{epic_id}.*.json"):
                td = load_json_safe(f)
                if td:
                    all_tasks[td.get("id", f.stem)] = td

        dependents = find_dependents(task_id, all_tasks)
        for dep_tid in dependents:
            reset_single_task(dep_tid)
            cascade_reset.append(dep_tid)

    # fn-587 task .4: re-stamp last_validated_at on the parent epic after the
    # structural write lands. The shared helper validates the post-mutation
    # tree and either returns a fresh stamp or emits a failure envelope.
    from planctl.validation_restamp import restamp_epic_or_fail

    epic_path = data_dir / "epics" / f"{epic_id}.json"
    new_stamp = restamp_epic_or_fail(epic_id, data_dir, verb="reset")
    epic_def = load_json(epic_path)
    epic_def["updated_at"] = now_iso()
    epic_def["last_validated_at"] = new_stamp
    atomic_write_json(epic_path, epic_def)

    # fn-629 task .3: route through the central seam. Rewrite of pre-existing
    # tracked files (atomic_write rename-atomic) → no unwind.
    emit(
        {"task_id": task_id, "status": "todo", "cascade_reset": cascade_reset},
        text_renderer=_render_human,
        verb="reset",
        target=task_id,
        repo_root=ctx.project_path,
        written_paths=[],
    )
    return 0
