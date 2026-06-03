"""planctl epic set-touched-repos - Replace the touched_repos list on an epic.

Non-blocking validation warning: for each path in --paths that is not a valid
git repo at set-time, a warning is accumulated in the JSON envelope's
``warnings: [...]`` field and a ``WARN:`` line is written to stderr.  The write
still succeeds and the exit code is 0 even when warnings fire — same warn-and-
write semantic as ``epic set-primary-repo`` (CWE-367 deferred-validation
argument).  Run ``planctl validate --epic <id>`` to confirm all paths are valid.

Manual override; subsequent ``set-target-repo`` / ``scaffold`` / ``refine-apply``
will recompute ``touched_repos`` from per-task values and clobber this write.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace


def run(args: SimpleNamespace) -> int:
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.run_validate import _validate_repo_path
    from planctl.store import atomic_write_json, load_json, now_iso

    epic_id: str = args.epic_id
    paths_arg: str = args.paths

    ctx = resolve_project()
    data_dir = ctx.data_dir

    epic_path = data_dir / "epics" / f"{epic_id}.json"
    if not epic_path.exists():
        emit_error(f"Epic not found: {epic_id}")

    touched_repos = [
        str(Path(p.strip()).expanduser().resolve())
        for p in paths_arg.split(",")
        if p.strip()
    ]

    # Non-blocking validation: warn for each path that is not a valid git repo.
    warnings: list[str] = []
    for repo_path in touched_repos:
        err = _validate_repo_path(repo_path, "touched_repos")
        if err is not None:
            msg = (
                f"{err}; 'planctl validate --epic {epic_id}' will reject this "
                "until the path is fixed"
            )
            warnings.append(msg)
            print(f"WARN: {msg}", file=sys.stderr)

    epic_def = load_json(epic_path)
    epic_def["touched_repos"] = touched_repos
    epic_def["updated_at"] = now_iso()
    atomic_write_json(epic_path, epic_def)

    # fn-587 task .4: re-stamp last_validated_at after the structural write.
    # Note: the warn-and-write path above is unchanged — this verb still emits
    # warnings + writes for any bad paths — but the post-write integrity check
    # will then fail and the helper emits a structured failure envelope.  The
    # write itself remains on disk.
    from planctl.validation_restamp import restamp_epic_or_fail

    new_stamp = restamp_epic_or_fail(epic_id, data_dir, verb="set-touched-repos")
    epic_def = load_json(epic_path)
    epic_def["last_validated_at"] = new_stamp
    atomic_write_json(epic_path, epic_def)

    primary_repo: str | None = epic_def.get("primary_repo")
    # fn-629 task .3: route through the central seam. Rewrite of a
    # pre-existing tracked file (atomic_write rename-atomic) → no unwind.
    emit(
        {"epic_id": epic_id, "touched_repos": touched_repos, "warnings": warnings},
        verb="set-touched-repos",
        target=epic_id,
        repo_root=ctx.project_path,
        primary_repo=primary_repo,
    )
    return 0
