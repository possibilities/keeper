"""planctl find-task-commit — read-only commit lookup for a single task.

A read-only, task-keyed sibling of ``resolve-task`` that wraps the shared
:func:`planctl.commit_lookup.find_commit_groups` native trailer scan and emits
the keeper-compatible flat envelope the worker's predecessor-detection branch
consumes::

    {"success": true, "commits": [{"sha": "<%H>", "repo": "<abs-path>"}, ...]}

The grouped ``[{repo, shas}]`` return of ``find_commit_groups`` is FLATTENED to
a single ``commits`` list — repo-outer first-seen order preserved, per-repo grep
order preserved, SHAs already deduped within a repo group by the module. Full
``%H`` SHAs; field names are ``sha`` / ``repo`` (NOT ``sha256`` / ``repo_path``)
for byte-compat with the harness-drop predecessor-detection the worker runs.

A clean miss (no commit carries a confirmed ``Task: <task_id>`` trailer) is a
normal empty success (``commits: []``, exit 0) — never an error. The verb fails
loud (``COMMIT_LOOKUP_FAILED``, exit 1) ONLY when every repo in the resolved
scan set is missing or not a git repo (:class:`AllReposBrokenError`), carrying
``details.broken_repos``.

Resolution is planctl-native: the owning project is found cwd-agnostically via
``find_projects_with_task`` (with a ``--project <abs>`` escape and the
``BAD_TASK_ID`` / ``TASK_NOT_FOUND`` / ``AMBIGUOUS_TASK_ID`` / ``NOT_A_PROJECT``
typed-error surface), then ``primary_repo`` / ``touched_repos`` are read off the
epic record (mirroring close-preflight) to seed the scan set. This is NOT
keeper's cwd-walk-up model — the worker runs from inside the repo, so cwd
≈ primary_repo in practice.

This is a **read-only** verb: it mutates nothing — no ``.planctl/`` write, no
commit — so ``files=None`` / ``subject=None`` ride the readonly invocation
payload and it stays OUT of ``cli._NO_TRACK_COMMANDS`` (the trailing read-only
``planctl_invocation`` line rides, like ``resolve-task``). On the error path it
sets the invocation sentinel so the decorator does not double-emit after the
terminal error envelope.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any, NoReturn, cast


def _emit_find_task_commit_error(
    code: str, message: str, *, details: dict[str, Any] | None = None
) -> NoReturn:
    """Emit a typed find-task-commit error envelope and exit 1.

    Shape ``{"success": false, "error": {"code", "message", "details"}}`` — no
    ``planctl_invocation`` line (a failed precondition / all-broken scan mutates
    nothing), sentinel set on the click context so ``InvocationTrackedGroup``
    does not emit a trailing read-only envelope after the failure. Mirrors
    ``run_resolve_task._emit_resolve_error``.
    """
    from planctl._util import format_output

    error: dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        error["details"] = details
    format_output({"success": False, "error": error})
    _set_invocation_sentinel()
    sys.exit(1)


def _set_invocation_sentinel() -> None:
    """Suppress the decorator's trailing readonly envelope on the failure path.

    Mirrors the helper in ``run_resolve_task`` / ``run_close_preflight``.
    """
    try:
        import click

        from planctl.output import INVOCATION_EMITTED_SENTINEL

        cctx = click.get_current_context()
        if cctx.obj is None:
            cctx.obj = {}
        if isinstance(cctx.obj, dict):
            cctx.obj[INVOCATION_EMITTED_SENTINEL] = True
    except RuntimeError:
        pass


def _context_for_root(project_root: Path):
    """Build a ProjectContext from a project root dir (the ``.planctl/`` parent).

    Kept local per the per-verb-duplication convention (mirrors
    ``run_resolve_task._context_for_root``).
    """
    from planctl.project import ProjectContext

    planctl_dir = project_root / ".planctl"
    return ProjectContext(
        name=project_root.name,
        data_dir=planctl_dir,
        state_dir=planctl_dir / "state",
        project_path=project_root,
    )


def _resolve_project_for_task(task_id: str, project: str | None):
    """Resolve the owning project for *task_id* cwd-agnostically.

    Same shape as ``run_resolve_task._resolve_project_for_task`` — ``--project
    <abs>`` escape (``NOT_A_PROJECT`` / ``TASK_NOT_FOUND`` on a bad target),
    else roots discovery via ``find_projects_with_task`` (``TASK_NOT_FOUND`` on
    a miss, ``AMBIGUOUS_TASK_ID`` on a same-id collision).
    """
    from planctl.discovery import find_projects_with_task

    if project is not None:
        project_root = Path(project).expanduser().resolve()
        if not (project_root / ".planctl").is_dir():
            _emit_find_task_commit_error(
                "NOT_A_PROJECT",
                f"No planctl project found at {project_root}. Run 'planctl init' first.",
            )
        ctx = _context_for_root(project_root)
        if not (ctx.data_dir / "tasks" / f"{task_id}.json").exists():
            _emit_find_task_commit_error(
                "TASK_NOT_FOUND",
                f"Task not found in {project_root}: {task_id}",
            )
        return ctx

    matches = find_projects_with_task(task_id)
    if not matches:
        _emit_find_task_commit_error("TASK_NOT_FOUND", f"Task not found: {task_id}")

    if len(matches) == 1:
        return _context_for_root(matches[0])

    _emit_find_task_commit_error(
        "AMBIGUOUS_TASK_ID",
        f"Task {task_id} exists in multiple projects; pass --project <path>.",
        details={"candidates": [str(p) for p in matches]},
    )


def run(args: SimpleNamespace) -> int:
    from planctl.commit_lookup import AllReposBrokenError, find_commit_groups
    from planctl.ids import epic_id_from_task, is_task_id
    from planctl.invocation import build_planctl_invocation_readonly
    from planctl.output import emit
    from planctl.store import load_json

    task_id: str = args.task_id
    project: str | None = getattr(args, "project", None)

    # 1. validate id (so epic_id_from_task's ValueError path is unreachable).
    if not is_task_id(task_id):
        _emit_find_task_commit_error("BAD_TASK_ID", f"Invalid task ID: {task_id}")

    # 2. resolve owning project cwd-agnostically (roots discovery or --project).
    ctx = _resolve_project_for_task(task_id, project)
    data_dir = ctx.data_dir

    # 3. derive epic id and read the scan-set seeds off the epic record
    #    (mirror close-preflight's primary_repo / touched_repos load).
    epic_id = epic_id_from_task(task_id)
    epic_path = data_dir / "epics" / f"{epic_id}.json"
    epic_def: dict[str, Any] = load_json(epic_path) if epic_path.exists() else {}
    primary_repo = str(Path(epic_def.get("primary_repo") or ctx.project_path).resolve())
    touched_repos = epic_def.get("touched_repos")

    # 4. native trailer scan; flatten the grouped result to the flat
    #    keeper-compatible commits list. A clean miss is [] (success exit 0);
    #    all-repos-broken raises and maps to COMMIT_LOOKUP_FAILED (exit 1).
    try:
        groups = find_commit_groups([task_id], primary_repo, touched_repos)
    except AllReposBrokenError as exc:
        _emit_find_task_commit_error(
            "COMMIT_LOOKUP_FAILED",
            (
                "commit-trailer scan found no usable repo: every repo in the "
                "scan set is missing or not a git repo"
            ),
            details={"broken_repos": exc.broken_repos},
        )

    # ``find_commit_groups`` types its return loosely (``list[dict[str, object]]``);
    # the documented shape is ``{"repo": <abs-path>, "shas": [<%H>, ...]}``. Cast
    # the inner values so the flatten is well-typed.
    commits = [
        {"sha": sha, "repo": cast("str", group["repo"])}
        for group in groups
        for sha in cast("list[str]", group["shas"])
    ]

    pc = build_planctl_invocation_readonly(
        "find-task-commit", task_id, repo_root=ctx.project_path
    )
    emit({"commits": commits}, planctl_invocation=pc)
    return 0
