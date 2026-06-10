"""planctl task set-target-repo - Change the target_repo on a task.

No set-time validation warning here (unlike ``epic set-primary-repo`` and
``epic set-touched-repos``).  The task worker validates target_repo at use-time
(Phase 1 re-anchor: cwd must match TARGET_REPO), so set-time is a premature
check and the warn-and-write pattern would add noise without benefit.  The
parent epic's ``primary_repo`` IS validated at set-time — the asymmetry is
intentional.

Also recomputes ``epic.touched_repos`` from the union of all tasks'
``target_repo`` values to maintain the auto-roll invariant (one atomic
mutation alongside the ``last_validated_at`` clear).
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace


def run(args: SimpleNamespace) -> int:
    from planctl.ids import epic_id_from_task
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.store import atomic_write_json, load_json, load_json_safe, now_iso

    task_id: str = args.task_id
    path_arg: str = args.path

    ctx = resolve_project()
    data_dir = ctx.data_dir

    task_path = data_dir / "tasks" / f"{task_id}.json"
    if not task_path.exists():
        emit_error(f"Task not found: {task_id}")

    resolved = str(Path(path_arg).expanduser().resolve())

    task_def = load_json(task_path)
    task_def["target_repo"] = resolved
    task_def["updated_at"] = now_iso()
    atomic_write_json(task_path, task_def)

    # Re-stamp validation marker on the parent epic and recompute touched_repos
    # from the union of every task's target_repo (including this task's new
    # value, just persisted above).  Filter to direct children only — `epic_id.M`
    # shape, no nested ids.
    #
    # ``last_validated_at`` is re-stamped (not cleared) after the
    # post-mutation integrity check passes.  The touched_repos recompute lands
    # first (so the integrity check sees the final tree), then the helper runs,
    # then the epic JSON is written once with both the recomputed touched_repos
    # and the fresh stamp.
    from planctl.validation_restamp import restamp_epic_or_fail

    epic_id = epic_id_from_task(task_id)
    epic_path = data_dir / "epics" / f"{epic_id}.json"
    epic_def = load_json_safe(epic_path)
    primary_repo: str | None = None
    if epic_def is not None:
        target_repos: set[str] = set()
        tasks_dir = data_dir / "tasks"
        prefix = f"{epic_id}."
        for task_file in tasks_dir.glob(f"{epic_id}.*.json"):
            stem = task_file.stem  # strip .json
            # Direct children only: stem must be `epic_id.M` (single segment after the prefix).
            suffix = stem[len(prefix) :]
            if "." in suffix:
                continue
            sibling = load_json(task_file)
            tr = sibling.get("target_repo")
            if tr:
                target_repos.add(tr)
        # Pre-write touched_repos so the integrity check sees the final tree.
        epic_def["touched_repos"] = sorted(target_repos)
        epic_def["updated_at"] = now_iso()
        atomic_write_json(epic_path, epic_def)
        new_stamp = restamp_epic_or_fail(epic_id, data_dir, verb="set-target-repo")
        # Reload (the integrity check may have surfaced concurrent edits) and
        # write the final stamp atomically.
        epic_def = load_json(epic_path)
        epic_def["last_validated_at"] = new_stamp
        atomic_write_json(epic_path, epic_def)
        primary_repo = epic_def.get("primary_repo")

    # Route through the central seam. Rewrite of pre-existing
    # tracked files (atomic_write rename-atomic) → no unwind.
    emit(
        {"task_id": task_id, "target_repo": resolved},
        verb="set-target-repo",
        target=task_id,
        repo_root=ctx.project_path,
        primary_repo=primary_repo,
    )
    return 0
