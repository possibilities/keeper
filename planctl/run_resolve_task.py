"""planctl resolve-task — read-only routing lookup (fn-593 task .1).

A read-only sibling of ``claim`` that returns the subset of fields a
dispatcher needs to route a ``/plan:work <task_id>`` invocation to the right
tier-plugin: same cwd-agnostic roots discovery, same typed-error surface
(``BAD_TASK_ID`` / ``TASK_NOT_FOUND`` / ``AMBIGUOUS_TASK_ID`` /
``NOT_A_PROJECT``), same envelope field names where they overlap. It
mutates nothing — no ``.planctl/`` write, no commit, no audit subject — so
``files=None`` / ``subject=None`` ride the readonly invocation payload.

The returned envelope is a deliberate subset of ``claim``'s 11-key briefing:
just the routing-relevant fields (``task_id``, ``epic_id``, ``project_path``,
``target_repo``, ``primary_repo``, ``tier``, ``status``). A caller uses
these to (a) pick the tier-plugin, (b) police cwd against ``target_repo``,
(c) decide what to do when ``tier`` is null. Task / epic spec markdown and
snippet context are NOT fetched here — re-rendering would double the cost
vs. the parent ``claim`` that runs after the routing step.

``tier`` is surfaced as an explicit JSON ``null`` (not key omission) when the
task has no persisted tier — a dispatcher branches on ``tier is None``
rather than treating absence as a default. ``status`` is the merged runtime
status (definition + ``.planctl/state/``) so callers see the live value, not
the on-disk-only definition value.

**Caller status:** the original consumer was the ``arthack-claude.py``
launcher, which shelled this verb on every ``/plan:work <task_id>`` launch.
That coupling was decoupled (fn-602): keeper now reads ``task.tier``
from its own projected Task data and dispatches model/effort/name/plugin-dir
directly, so the launcher no longer calls planctl at startup. The verb is
retained as a public CLI surface for future routing consumers; today it has
no in-tree caller.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any, NoReturn


def _emit_resolve_error(
    code: str, message: str, *, details: dict[str, Any] | None = None
) -> NoReturn:
    """Emit a typed resolve-task error envelope and exit 1.

    Mirrors ``run_claim._emit_claim_error`` — shape
    ``{"success": false, "error": {"code", "message", "details"}}``, no
    ``planctl_invocation`` line (failed precondition mutates nothing), sentinel
    set on the click context so ``InvocationTrackedGroup.invoke`` does not
    emit a trailing read-only envelope after the failure.
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

    Mirrors the helper in ``run_claim``.
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
    """Build a ProjectContext from a project root dir (the ``.planctl/`` parent)."""
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

    Same shape as ``run_claim._resolve_project_for_task`` but without the
    "filter to claimable on ambiguity" pass — resolve-task is for routing, not
    claiming, so any same-id collision is surfaced as ``AMBIGUOUS_TASK_ID`` for
    the launcher to bounce back to the human with ``--project <path>``.
    """
    from planctl.discovery import find_projects_with_task

    if project is not None:
        project_root = Path(project).expanduser().resolve()
        if not (project_root / ".planctl").is_dir():
            _emit_resolve_error(
                "NOT_A_PROJECT",
                f"No planctl project found at {project_root}. Run 'planctl init' first.",
            )
        ctx = _context_for_root(project_root)
        if not (ctx.data_dir / "tasks" / f"{task_id}.json").exists():
            _emit_resolve_error(
                "TASK_NOT_FOUND",
                f"Task not found in {project_root}: {task_id}",
            )
        return ctx

    matches = find_projects_with_task(task_id)
    if not matches:
        _emit_resolve_error("TASK_NOT_FOUND", f"Task not found: {task_id}")

    if len(matches) == 1:
        return _context_for_root(matches[0])

    _emit_resolve_error(
        "AMBIGUOUS_TASK_ID",
        f"Task {task_id} exists in multiple projects; pass --project <path>.",
        details={"candidates": [str(p) for p in matches]},
    )


def run(args: SimpleNamespace) -> int:
    from planctl.ids import epic_id_from_task, is_task_id
    from planctl.invocation import build_planctl_invocation_readonly
    from planctl.models import merge_task_state, normalize_task, worker_agent_for_tier
    from planctl.output import emit
    from planctl.runtime_status import _expected_worker_cwd
    from planctl.store import LocalFileStateStore, load_json

    task_id: str = args.task_id
    project: str | None = getattr(args, "project", None)

    # 1. validate id
    if not is_task_id(task_id):
        _emit_resolve_error("BAD_TASK_ID", f"Invalid task ID: {task_id}")

    # 2. resolve owning project cwd-agnostically (roots discovery or --project)
    ctx = _resolve_project_for_task(task_id, project)
    data_dir = ctx.data_dir

    task_path = data_dir / "tasks" / f"{task_id}.json"
    task_def = normalize_task(load_json(task_path))

    epic_id = epic_id_from_task(task_id)
    epic_path = data_dir / "epics" / f"{epic_id}.json"
    epic_def: dict[str, Any] = load_json(epic_path) if epic_path.exists() else {}

    # 3. resolve target_repo / primary_repo (three-level fallback, realpath-normalized).
    #    Field names match `claim`'s envelope so the launcher has one parser.
    proj_path = str(ctx.project_path)
    target_repo = str(
        Path(_expected_worker_cwd(task_def, epic_def, proj_path)).resolve()
    )
    primary_repo = str(Path(epic_def.get("primary_repo") or proj_path).resolve())

    # 4. merged runtime status (definition + state-dir overlay).
    state_store = LocalFileStateStore(ctx.state_dir)
    runtime = state_store.load_runtime(task_id)
    merged = merge_task_state(task_def, runtime)
    status = merged.get("status", "todo")

    tier = task_def.get("tier")  # explicit null when never set — see module docstring

    pc = build_planctl_invocation_readonly(
        "resolve-task", task_id, repo_root=ctx.project_path
    )
    emit(
        {
            "task_id": task_id,
            "epic_id": epic_id,
            "project_path": proj_path,
            "target_repo": target_repo,
            "primary_repo": primary_repo,
            "tier": tier,
            "worker_agent": worker_agent_for_tier(tier),
            "status": status,
        },
        planctl_invocation=pc,
    )
    return 0
