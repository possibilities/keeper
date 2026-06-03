"""planctl task set-acceptance - Set the Acceptance section of a task spec."""

from __future__ import annotations

from types import SimpleNamespace


def _render_human(data: dict) -> str:
    return f"Updated Acceptance for {data.get('task_id')}"


def run(args: SimpleNamespace) -> int:
    from planctl.ids import epic_id_from_task
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.specs import (
        ensure_valid_task_spec,
        patch_task_section,
    )
    from planctl.store import (
        atomic_write,
        atomic_write_json,
        load_json,
        now_iso,
        read_file_or_stdin,
    )

    task_id: str = args.task_id
    file: str | None = args.file

    ctx = resolve_project()
    data_dir = ctx.data_dir

    task_path = data_dir / "tasks" / f"{task_id}.json"
    if not task_path.exists():
        emit_error(f"Task not found: {task_id}")

    task_def = load_json(task_path)
    new_content = read_file_or_stdin(file)

    # Load current spec
    spec_path = data_dir / "specs" / f"{task_id}.md"
    if not spec_path.exists():
        emit_error(f"Spec file not found: {spec_path}")
    current_spec = spec_path.read_text(encoding="utf-8")
    try:
        ensure_valid_task_spec(current_spec)
    except ValueError as e:
        emit_error(f"Task spec is malformed for {task_id}: {e}")

    # Patch section
    try:
        patched = patch_task_section(current_spec, "## Acceptance", new_content)
        ensure_valid_task_spec(patched)
    except ValueError as e:
        emit_error(str(e))

    atomic_write(spec_path, patched)

    task_def["updated_at"] = now_iso()
    atomic_write_json(task_path, task_def)

    # fn-587 task .4: re-stamp last_validated_at on the parent epic after the
    # structural write lands. The shared helper validates the post-mutation
    # tree and either returns a fresh stamp or emits a failure envelope.
    from planctl.validation_restamp import restamp_epic_or_fail

    epic_id = epic_id_from_task(task_id)
    epic_path = data_dir / "epics" / f"{epic_id}.json"
    new_stamp = restamp_epic_or_fail(epic_id, data_dir, verb="set-acceptance")
    epic_def = load_json(epic_path)
    epic_def["updated_at"] = now_iso()
    epic_def["last_validated_at"] = new_stamp
    atomic_write_json(epic_path, epic_def)

    # fn-629 task .3: route through the central seam. All three writes
    # (spec markdown + task JSON + epic JSON) are rewrites of pre-existing
    # tracked files (atomic_write rename-atomic) → no unwind.
    emit(
        {"task_id": task_id, "section": "Acceptance"},
        text_renderer=_render_human,
        verb="set-acceptance",
        target=task_id,
        repo_root=ctx.project_path,
    )
    return 0
