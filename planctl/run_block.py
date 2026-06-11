"""planctl block - Mark a task as blocked."""

from __future__ import annotations

from types import SimpleNamespace


def run(args: SimpleNamespace) -> int:
    from planctl.ids import is_task_id
    from planctl.invocation import build_planctl_invocation_readonly
    from planctl.models import merge_task_state
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.store import LocalFileStateStore, load_json, now_iso

    task_id: str = args.task_id
    reason: str | None = args.reason
    reason_file: str | None = args.reason_file

    if not is_task_id(task_id):
        emit_error(f"Invalid task ID: {task_id}")

    ctx = resolve_project()
    data_dir = ctx.data_dir
    state_store = LocalFileStateStore(ctx.state_dir)

    task_path = data_dir / "tasks" / f"{task_id}.json"
    if not task_path.exists():
        emit_error(f"Task not found: {task_id}")

    task_def = load_json(task_path)

    # Read reason
    reason_text = ""
    if reason:
        reason_text = reason
    elif reason_file:
        from pathlib import Path

        reason_text = Path(reason_file).read_text(encoding="utf-8")

    with state_store.lock_task(task_id):
        runtime = state_store.load_runtime(task_id)
        merged = merge_task_state(task_def, runtime)
        status = merged.get("status", "todo")

        if status == "done":
            emit_error(f"Task {task_id} is done and cannot be blocked")

        now = now_iso()
        new_state = {
            "status": "blocked",
            "updated_at": now,
            "blocked_reason": reason_text,
            "assignee": merged.get("assignee"),
            "claimed_at": merged.get("claimed_at"),
            "claim_note": merged.get("claim_note", ""),
            "evidence": merged.get("evidence"),
        }
        state_store.save_runtime(task_id, new_state)

    # Clear this session's work marker (guard contract) — only if it names this
    # task. Success-path only, fail-open.
    from planctl.session_markers import clear_work_marker

    clear_work_marker(task_id)

    pc = build_planctl_invocation_readonly("block", task_id, repo_root=ctx.project_path)
    emit(
        {"task_id": task_id, "status": "blocked", "blocked_reason": reason_text},
        planctl_invocation=pc,
    )
    return 0
