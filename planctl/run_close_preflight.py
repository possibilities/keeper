"""planctl close-preflight - read-only close-readiness fetch for /plan:close.

Collapses the /plan:close Phase 0a/2 hand-fired sequence (``show`` for
primary_repo, ``tasks`` for the readiness confirm, the ``set -eo pipefail``
``COMMIT_GROUPS`` bash pipeline, and the ``promptctl render-spec`` snippet
fetch) into a single read-only verb that returns one envelope:

    {
      "primary_repo": <abs-path>,
      "tasks": [{"id", "title", "status"}, ...],
      "all_done": <bool>,         # every task status == "done"
      "commit_groups": [{"repo", "shas": [...]}, ...],
      "snippet_context": <str>,   # promptctl render-spec <epic_id> --format human
    }

Resolution is cwd-based via ``resolve_project`` — ``/plan:close`` already
``cd``s to ``primary_repo`` in Phase 0a, so no epic-keyed discovery is needed.

**Fail-loud on the first ``jobctl find-task-commit`` failure** (replicating the
old pipeline's ``set -eo pipefail`` semantics) rather than truncating
``commit_groups``. The render and commit-group fetches are read-only shell-outs;
any non-zero exit emits a typed ``{success:false, error:{code,message,details}}``
envelope (claim's single-fetch error shape) and exits 1.

This is a **read-only** verb: it mutates nothing and rides the
``InvocationTrackedGroup`` auto-readonly invocation line (NOT in
``_NO_TRACK_COMMANDS``), same as ``detect`` / ``status`` / ``gravity``. On the
error path it sets the invocation sentinel so the decorator does not double-emit
after the terminal error envelope.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any, NoReturn


def _emit_preflight_error(
    code: str, message: str, *, details: dict[str, Any] | None = None
) -> NoReturn:
    """Emit a typed close-preflight error envelope and exit 1.

    Shape: ``{"success": false, "error": {"code", "message", "details"}}``
    (claim's single-fetch error shape). Routes through ``format_output`` so
    ``--format yaml`` renders YAML. No ``planctl_invocation`` is emitted — a
    failed read-only fetch mutates nothing. The sentinel guards the
    ``InvocationTrackedGroup`` decorator against double-emitting a trailing
    read-only envelope after this terminal error. Mirrors
    ``run_claim._emit_claim_error``.
    """
    from planctl._util import format_output

    error: dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        error["details"] = details
    format_output({"success": False, "error": error})
    _set_invocation_sentinel()
    sys.exit(1)


def _set_invocation_sentinel() -> None:
    """Set INVOCATION_EMITTED_SENTINEL on the active click context.

    Guards ``InvocationTrackedGroup.invoke`` against emitting a trailing
    read-only ``planctl_invocation`` line after our error path already wrote a
    terminal envelope. No-op when there is no active click context (tests
    calling ``run()`` directly). Mirrors ``run_claim._set_invocation_sentinel``.
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


def _render_snippet_context(epic_id: str, primary_repo: str) -> str:
    """Shell ``promptctl render-spec <epic_id> --format human`` with cwd=primary_repo.

    Empty stdout on exit 0 → ``""`` (the epic has no curated substrate set);
    non-zero exit → ``SNIPPET_RENDER_FAILED`` (no mutation). Reuses the
    ``run_claim._render_snippet_context`` pattern. No ``--session-id`` — the
    dedup-against-seen-set is a worker-render concern, not the close fetch.
    """
    try:
        proc = subprocess.run(
            ["promptctl", "render-spec", epic_id, "--format", "human"],
            cwd=str(Path(primary_repo).resolve()),
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
    except OSError as exc:
        _emit_preflight_error(
            "SNIPPET_RENDER_FAILED",
            f"failed to shell promptctl render-spec for {epic_id}: {exc}",
        )
    if proc.returncode != 0:
        _emit_preflight_error(
            "SNIPPET_RENDER_FAILED",
            f"promptctl render-spec exited {proc.returncode} for {epic_id}",
            details={"stderr": (proc.stderr or "").strip()},
        )
    return proc.stdout


def _commit_groups(task_ids: list[str], primary_repo: str) -> list[dict[str, Any]]:
    """Group ``jobctl find-task-commit`` output by repo, fail-loud on first failure.

    Replicates the old skill pipeline's ``set -eo pipefail`` semantics + the
    ``group_by(.repo) | map({repo, shas})`` jq recipe: shell
    ``jobctl find-task-commit <task_id>`` per task, collect every
    ``{repo, sha}`` commit, and group into ``[{repo, shas:[...]}]`` in
    first-seen repo order. The FIRST non-zero ``jobctl`` exit aborts with a
    typed ``COMMIT_LOOKUP_FAILED`` error rather than truncating the result.
    """
    import json

    # repo -> list[sha], preserving first-seen repo order.
    grouped: dict[str, list[str]] = {}
    order: list[str] = []

    for task_id in task_ids:
        try:
            proc = subprocess.run(
                ["jobctl", "find-task-commit", task_id],
                cwd=str(Path(primary_repo).resolve()),
                capture_output=True,
                text=True,
                encoding="utf-8",
            )
        except OSError as exc:
            _emit_preflight_error(
                "COMMIT_LOOKUP_FAILED",
                f"failed to shell jobctl find-task-commit for {task_id}: {exc}",
            )
        if proc.returncode != 0:
            _emit_preflight_error(
                "COMMIT_LOOKUP_FAILED",
                f"jobctl find-task-commit exited {proc.returncode} for {task_id}",
                details={"task_id": task_id, "stderr": (proc.stderr or "").strip()},
            )
        try:
            payload = json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            _emit_preflight_error(
                "COMMIT_LOOKUP_FAILED",
                f"jobctl find-task-commit returned unparseable JSON for {task_id}: {exc}",
                details={"task_id": task_id, "stdout": (proc.stdout or "").strip()},
            )
        for commit in payload.get("commits", []):
            repo = commit.get("repo")
            sha = commit.get("sha")
            if repo is None or sha is None:
                continue
            if repo not in grouped:
                grouped[repo] = []
                order.append(repo)
            grouped[repo].append(sha)

    return [{"repo": repo, "shas": grouped[repo]} for repo in order]


def _context_for_root(project_root: Path):
    """Build a ProjectContext from a project root dir (the ``.planctl/`` parent).

    Mirrors ``run_claim._context_for_root`` — kept local so the read-only
    ``run_close_preflight`` module stays self-contained. fn-589 task .1
    (item 4): used by the ``--project`` override path.
    """
    from planctl.project import ProjectContext

    planctl_dir = project_root / ".planctl"
    return ProjectContext(
        name=project_root.name,
        data_dir=planctl_dir,
        state_dir=planctl_dir / "state",
        project_path=project_root,
    )


def run(args: SimpleNamespace) -> int:
    import click

    from planctl.api import load_epic, load_tasks_for_epic, task_sort_key
    from planctl.ids import is_epic_id
    from planctl.output import emit
    from planctl.project import resolve_project

    epic_id: str = args.epic_id
    project: str | None = getattr(args, "project", None)

    if not is_epic_id(epic_id):
        _emit_preflight_error("BAD_EPIC_ID", f"Invalid epic ID: {epic_id}")

    # fn-589 task .1 (item 4): mirror claim's --project shape.  Absolute paths
    # only — relative paths raise UsageError (cwd-dependent semantics under a
    # flag whose whole point is cwd-independence is a footgun).  Unset → fall
    # through to existing resolve_project() cwd-walk.
    if project is not None:
        project_path_obj = Path(project).expanduser()
        if not project_path_obj.is_absolute():
            raise click.UsageError(
                f"--project requires an absolute path, got: {project}"
            )
        project_root = project_path_obj.resolve()
        if not (project_root / ".planctl").is_dir():
            _emit_preflight_error(
                "NOT_A_PROJECT",
                (
                    f"No planctl project found at {project_root}. "
                    f"Run 'planctl init' first."
                ),
            )
        ctx = _context_for_root(project_root)
    else:
        ctx = resolve_project()

    epic_path = ctx.data_dir / "epics" / f"{epic_id}.json"
    if not epic_path.exists():
        _emit_preflight_error(
            "EPIC_NOT_FOUND",
            f"Epic not found in {ctx.project_path}: {epic_id}",
        )

    epic_def = load_epic(ctx, epic_id)
    primary_repo = str(Path(epic_def.get("primary_repo") or ctx.project_path).resolve())

    # Tasks, sorted by ordinal, with runtime state merged in.
    merged_tasks = sorted(
        load_tasks_for_epic(ctx, epic_id),
        key=lambda t: task_sort_key(t.get("id", "")),
    )
    tasks = [
        {
            "id": t.get("id"),
            "title": t.get("title"),
            "status": t.get("status", "todo"),
        }
        for t in merged_tasks
    ]
    all_done = bool(tasks) and all(t["status"] == "done" for t in tasks)

    # Read-only shell-outs — fail loud on the first failure (no mutation).
    commit_groups = _commit_groups([t["id"] for t in tasks if t["id"]], primary_repo)
    snippet_context = _render_snippet_context(epic_id, primary_repo)

    emit(
        {
            "primary_repo": primary_repo,
            "tasks": tasks,
            "all_done": all_done,
            "commit_groups": commit_groups,
            "snippet_context": snippet_context,
        }
    )
    return 0
