"""planctl task set-snippets — replace the snippet-id list on a task.

Replace-only semantics (mirrors ``set-deps`` / ``set-touched-repos``): the
``--snippets`` value fully replaces ``task.snippets``.  ``--snippets ""`` (or
``--snippets`` with no value) clears the list.  No ``--append`` flag — if
append is later wanted, add a new verb rather than overloading this one.

Snippet ids are validated as non-empty kebab-case strings only; no existence
check (phantom ids surface as warnings at ``promptctl render-spec`` time per
the Epic 1 runtime-substrate design).

Joins ``VALIDATION_RESTAMP_VERBS`` — replacing the snippet list is a structural
change to spec metadata, so the parent epic's ``last_validated_at`` is cleared
(mirrors ``set-deps``).
"""

from __future__ import annotations

from types import SimpleNamespace

from planctl.bundle_ref import SNIPPET_ID_RE


def _render_human(data: dict) -> str:
    snippets = data.get("snippets", [])
    body = ", ".join(snippets) if snippets else "(cleared)"
    return f"Set snippets for {data.get('task_id')}: {body}"


def run(args: SimpleNamespace) -> int:
    from planctl.ids import epic_id_from_task, is_task_id
    from planctl.models import normalize_task
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.store import atomic_write_json, load_json, now_iso

    task_id: str = args.task_id
    snippets_arg: str | None = args.snippets

    if not is_task_id(task_id):
        emit_error(f"Invalid task ID: {task_id}")

    raw = snippets_arg or ""
    snippets = [s.strip() for s in raw.split(",") if s.strip()]

    for sid in snippets:
        if not SNIPPET_ID_RE.match(sid):
            emit_error(
                f"Invalid snippet id: {sid!r}. Must be non-empty kebab-case "
                "(lowercase alnum, single dashes)."
            )

    ctx = resolve_project()
    data_dir = ctx.data_dir

    task_path = data_dir / "tasks" / f"{task_id}.json"
    if not task_path.exists():
        emit_error(f"Task not found: {task_id}")

    task_def = normalize_task(load_json(task_path))
    task_def["snippets"] = snippets
    task_def["updated_at"] = now_iso()
    atomic_write_json(task_path, task_def)

    # Re-stamp validation marker on the parent epic after the
    # structural write lands.  Replacing the snippet list is a structural spec-
    # metadata change (mirrors set-deps); the shared helper validates the
    # post-mutation tree and either returns a fresh stamp or emits a failure
    # envelope.
    from planctl.validation_restamp import restamp_epic_or_fail

    epic_id = epic_id_from_task(task_id)
    epic_path = data_dir / "epics" / f"{epic_id}.json"
    if epic_path.exists():
        new_stamp = restamp_epic_or_fail(epic_id, data_dir, verb="set-snippets")
        epic_def = load_json(epic_path)
        epic_def["updated_at"] = now_iso()
        epic_def["last_validated_at"] = new_stamp
        atomic_write_json(epic_path, epic_def)

    # Route through the central seam. Rewrite of pre-existing
    # tracked files (atomic_write rename-atomic) → no unwind.
    emit(
        {"task_id": task_id, "snippets": snippets},
        text_renderer=_render_human,
        verb="set-snippets",
        target=task_id,
        repo_root=ctx.project_path,
    )
    return 0
