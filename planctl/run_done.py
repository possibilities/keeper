"""planctl done - Mark a task as complete."""

from __future__ import annotations

from types import SimpleNamespace


def run(args: SimpleNamespace) -> int:
    import json

    from planctl.ids import is_task_id
    from planctl.models import merge_task_state
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
        get_actor,
        load_json,
        now_iso,
    )

    task_id: str = args.task_id
    summary: str | None = args.summary
    evidence_inline: str | None = args.evidence
    force: bool = args.force

    if not is_task_id(task_id):
        emit_error(f"Invalid task ID: {task_id}")

    ctx = resolve_project()
    data_dir = ctx.data_dir
    state_store = LocalFileStateStore(ctx.state_dir)

    task_path = data_dir / "tasks" / f"{task_id}.json"
    if not task_path.exists():
        emit_error(f"Task not found: {task_id}")

    task_def = load_json(task_path)
    actor = get_actor()

    with state_store.lock_task(task_id):
        runtime = state_store.load_runtime(task_id)
        merged = merge_task_state(task_def, runtime)
        status = merged.get("status", "todo")

        if status == "done":
            emit_error(f"Task {task_id} is already done")

        if not force:
            if status != "in_progress":
                emit_error(f"Task {task_id} is not in_progress (status: {status})")
            current_assignee = merged.get("assignee")
            if current_assignee and current_assignee != actor:
                emit_error(
                    f"Task {task_id} is assigned to {current_assignee}, not {actor}"
                )

        # Read summary
        summary_text = ""
        if summary:
            summary_text = summary

        # Read evidence
        evidence: dict = {"commits": [], "tests": [], "prs": []}
        if evidence_inline:
            try:
                evidence_data = json.loads(evidence_inline)
            except json.JSONDecodeError as e:
                emit_error(f"Invalid evidence JSON: {e}")
        else:
            evidence_data = {}

        # Normalize evidence
        if isinstance(evidence_data, dict):
            evidence = {
                "commits": list(evidence_data.get("commits", [])),
                "tests": list(evidence_data.get("tests", [])),
                "prs": list(evidence_data.get("prs", [])),
            }
        else:
            emit_error("Evidence must be a JSON object")

        # Patch spec
        spec_path = data_dir / "specs" / f"{task_id}.md"
        if not spec_path.exists():
            emit_error(f"Spec file not found: {spec_path}")

        spec_content = spec_path.read_text(encoding="utf-8")
        try:
            ensure_valid_task_spec(spec_content)
            spec_content = patch_task_section(
                spec_content, "## Done summary", summary_text
            )
        except ValueError as e:
            emit_error(f"Task spec is malformed for {task_id}: {e}")

        # Format evidence for spec
        evidence_lines = []
        if evidence["commits"]:
            evidence_lines.append(f"- Commits: {', '.join(evidence['commits'])}")
        if evidence["tests"]:
            evidence_lines.append(f"- Tests: {', '.join(evidence['tests'])}")
        if evidence["prs"]:
            evidence_lines.append(f"- PRs: {', '.join(evidence['prs'])}")
        evidence_text = "\n".join(evidence_lines) if evidence_lines else ""

        try:
            spec_content = patch_task_section(
                spec_content, "## Evidence", evidence_text
            )
            ensure_valid_task_spec(spec_content)
        except ValueError as e:
            emit_error(f"Task spec is malformed for {task_id}: {e}")

        atomic_write(spec_path, spec_content)

        # Update runtime state
        now = now_iso()
        new_state = {
            "status": "done",
            "updated_at": now,
            "assignee": merged.get("assignee", actor),
            "claimed_at": merged.get("claimed_at"),
            "claim_note": merged.get("claim_note", ""),
            "evidence": evidence,
            "blocked_reason": None,
        }
        state_store.save_runtime(task_id, new_state)

    # Update definition
    now = now_iso()
    task_def["updated_at"] = now
    # Stamp worker_done_at on the tracked task definition (NOT on the
    # gitignored runtime-state file). This stamp is the completion signal
    # keeper folds: a task with worker_done_at set is complete.
    task_def["worker_done_at"] = now
    atomic_write_json(task_path, task_def)

    # Clear this session's work marker (guard contract) — only if it names this
    # task; a marker for a different task is left intact. Success-path only,
    # fail-open.
    from planctl.session_markers import clear_work_marker

    clear_work_marker(task_id)

    # Route through the central seam. Rewrite of pre-existing
    # tracked files (atomic_write rename-atomic) → no unwind.
    emit(
        {"task_id": task_id, "status": "done", "evidence": evidence},
        verb="done",
        target=task_id,
        repo_root=ctx.project_path,
    )
    return 0
