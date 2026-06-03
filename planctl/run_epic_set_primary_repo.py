"""planctl epic set-primary-repo - Change the primary_repo on an epic.

NOTE: This is a metadata-only operation. It does NOT physically move any
.planctl/ state files. If you change primary_repo to a new path, you must
also manually move the .planctl/ directory to the new location. Mismatch
between primary_repo and actual state location will cause validation errors.

Non-blocking validation warning: if the resolved path is not a valid git repo
at set-time, a warning is emitted in the JSON envelope's ``warnings: [...]``
field and a ``WARN:`` line is written to stderr, but the write still succeeds
and the exit code is 0.  The warn-and-write semantic is intentional — the path
may be staged for a move that hasn't happened yet (CWE-367 deferred-validation
argument).  Run ``planctl validate --epic <id>`` to confirm the path is valid.
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
    path_arg: str = args.path

    ctx = resolve_project()
    data_dir = ctx.data_dir

    epic_path = data_dir / "epics" / f"{epic_id}.json"
    if not epic_path.exists():
        emit_error(f"Epic not found: {epic_id}")

    resolved = str(Path(path_arg).expanduser().resolve())

    # Non-blocking validation: warn if the path is not a valid git repo.
    warnings: list[str] = []
    err = _validate_repo_path(resolved, "primary_repo")
    if err is not None:
        msg = (
            f"{err}; 'planctl validate --epic {epic_id}' will reject this "
            "until the path is fixed"
        )
        warnings.append(msg)
        print(f"WARN: {msg}", file=sys.stderr)

    epic_def = load_json(epic_path)
    epic_def["primary_repo"] = resolved
    epic_def["updated_at"] = now_iso()
    atomic_write_json(epic_path, epic_def)

    # fn-587 task .4: re-stamp last_validated_at after the structural write.
    # Note: the warn-and-write path above is unchanged — this verb still emits
    # a warning + writes for a bad path — but the post-write integrity check
    # will then fail and the helper emits a structured failure envelope.  The
    # write itself remains on disk (recoverable via a follow-up valid-path
    # set-primary-repo call).
    from planctl.validation_restamp import restamp_epic_or_fail

    new_stamp = restamp_epic_or_fail(epic_id, data_dir, verb="set-primary-repo")
    epic_def = load_json(epic_path)
    epic_def["last_validated_at"] = new_stamp
    atomic_write_json(epic_path, epic_def)

    # fn-629 task .3: route through the central seam. Rewrite of a
    # pre-existing tracked file (atomic_write rename-atomic) → no unwind.
    emit(
        {"epic_id": epic_id, "primary_repo": resolved, "warnings": warnings},
        verb="set-primary-repo",
        target=epic_id,
        repo_root=ctx.project_path,
        primary_repo=resolved,
        written_paths=[],
    )
    return 0
