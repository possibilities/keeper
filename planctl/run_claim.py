"""planctl claim - Assert invariants, claim a task, and return the worker briefing.

Renamed from ``planctl start`` (fn-542 task .2). Where ``start`` only flipped
``todo → in_progress`` and emitted a thin status envelope, ``claim`` collapses
the orchestrator's hand-fired sequence (validate / show / cat / render-spec /
start) into one call:

1. **Assert** every precondition BEFORE any mutation — project resolves, id is
   well-formed, task exists, target_repo resolves, status/deps gate passes.
   Each failure returns a typed ``{success:false, error:{code,message,details}}``
   envelope and exits 1; nothing is mutated so no audit row lands.
2. **Compute** all read-only briefing context (task + epic spec markdown, repos,
   tier, folded-in ``promptctl render-spec`` snippet context) BEFORE the single
   mutation, so a render failure strands nothing.
3. **CAS** under ``lock_task``: read-merge-decide-write in one lock. Outcomes:
   ``CLAIMED`` (todo→in_progress), ``ALREADY_MINE`` (same actor, idempotent),
   ``CLAIMED_BY_OTHER`` (error). ``--force`` takes over and bypasses
   ``CLAIMED_BY_OTHER`` / ``TASK_BLOCKED`` / ``DEPS_UNMET`` but never ``TASK_DONE``.
4. **Emit** the 11-key briefing envelope with the readonly invocation builder —
   ``claim`` mutates only the gitignored ``.planctl/state/``; no commit-plan seam
   covers it.

Resolution is cwd-agnostic (fn-542 task .3): the owning project is found via
roots discovery (scan the configured ``roots`` for the project whose
``.planctl/tasks/<task_id>.json`` exists), with a ``--project <path>`` override
that bypasses discovery. There is no ``WRONG_DIRECTORY`` / ``cd`` notion — claim
runs from any directory. ``AMBIGUOUS_TASK_ID`` (with candidate paths) and
``TASK_NOT_FOUND`` cover the discovery edge cases.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any, NoReturn


def _emit_claim_error(
    code: str, message: str, *, details: dict[str, Any] | None = None
) -> NoReturn:
    """Emit a typed claim error envelope and exit 1.

    Shape: ``{"success": false, "error": {"code", "message", "details"}}``.
    Routes through ``format_output`` so ``--format yaml`` renders YAML. No
    ``planctl_invocation`` is emitted — a failed precondition mutates nothing,
    so no audit row should land. The ``InvocationTrackedGroup`` decorator would
    otherwise emit a trailing read-only envelope after the verb returns; we set
    its sentinel here so it does not double-emit on the failure path.
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
    terminal envelope. Mirrors ``run_resolve_task._set_invocation_sentinel``.
    No-op when there is no active click context (tests calling ``run()``
    directly).
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


def _is_claimable(ctx, task_id: str) -> bool:
    """Whether *task_id* in *ctx* is a claimable candidate (open epic + claimable task).

    Used to disambiguate transitional same-id collisions across projects: a
    match counts only when its parent epic is open AND the task's runtime status
    is ``todo`` / ``in_progress`` (done / blocked tasks are not claim targets).
    A missing epic JSON or unreadable state fails closed (not claimable).
    """
    from planctl.ids import epic_id_from_task
    from planctl.models import merge_task_state
    from planctl.store import LocalFileStateStore, load_json

    data_dir = ctx.data_dir
    task_path = data_dir / "tasks" / f"{task_id}.json"
    if not task_path.exists():
        return False
    try:
        epic_id = epic_id_from_task(task_id)
        epic_path = data_dir / "epics" / f"{epic_id}.json"
        if not epic_path.exists():
            return False
        epic_def = load_json(epic_path)
        if epic_def.get("status") != "open":
            return False
        task_def = load_json(task_path)
        runtime = LocalFileStateStore(ctx.state_dir).load_runtime(task_id)
        status = merge_task_state(task_def, runtime).get("status", "todo")
        return status in ("todo", "in_progress")
    except (OSError, ValueError):
        return False


def _resolve_project_for_task(task_id: str, project: str | None):
    """Resolve the owning project for *task_id*, cwd-agnostically (fn-542 task .3).

    Resolution order:

    1. ``--project <path>`` override (when *project* is set) — resolve that path
       directly, bypassing discovery. ``NOT_A_PROJECT`` if it has no ``.planctl/``;
       ``TASK_NOT_FOUND`` if the task JSON is absent there.
    2. Zero-arg: scan the configured ``roots`` for projects whose
       ``.planctl/tasks/<task_id>.json`` exists. Exactly one match → use it.
       Multiple matches → filter to **claimable** ones (open epic + todo/in_progress
       task); exactly one claimable → use it, otherwise ``AMBIGUOUS_TASK_ID``
       (``details.candidates`` = candidate project paths). Zero matches anywhere →
       ``TASK_NOT_FOUND``.

    No cwd dependency, no ``WRONG_DIRECTORY`` — claim works from any directory.
    """
    from planctl.discovery import find_projects_with_task

    if project is not None:
        project_root = Path(project).expanduser().resolve()
        if not (project_root / ".planctl").is_dir():
            _emit_claim_error(
                "NOT_A_PROJECT",
                f"No planctl project found at {project_root}. Run 'planctl init' first.",
            )
        ctx = _context_for_root(project_root)
        if not (ctx.data_dir / "tasks" / f"{task_id}.json").exists():
            _emit_claim_error(
                "TASK_NOT_FOUND",
                f"Task not found in {project_root}: {task_id}",
            )
        return ctx

    matches = find_projects_with_task(task_id)
    if not matches:
        _emit_claim_error("TASK_NOT_FOUND", f"Task not found: {task_id}")

    if len(matches) == 1:
        return _context_for_root(matches[0])

    # Transitional same-id collision across projects: keep only claimable ones.
    contexts = [_context_for_root(p) for p in matches]
    claimable = [c for c in contexts if _is_claimable(c, task_id)]
    if len(claimable) == 1:
        return claimable[0]

    _emit_claim_error(
        "AMBIGUOUS_TASK_ID",
        f"Task {task_id} exists in multiple projects; pass --project <path>.",
        details={"candidates": [str(c.project_path) for c in contexts]},
    )


def _render_snippet_context(task_id: str, primary_repo: str) -> str:
    """Shell ``promptctl render-spec <task_id> --format human`` with cwd=primary_repo.

    Computed BEFORE the CAS so a render failure strands no claim. Empty stdout
    on exit 0 → ``""``; non-zero exit → ``SNIPPET_RENDER_FAILED`` (no mutation).
    No ``--session-id`` is passed — dedup-against-seen-set is a worker-render
    concern, not the briefing fetch.
    """
    try:
        proc = subprocess.run(
            ["promptctl", "render-spec", task_id, "--format", "human"],
            cwd=str(Path(primary_repo).resolve()),
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
    except OSError as exc:
        _emit_claim_error(
            "SNIPPET_RENDER_FAILED",
            f"failed to shell promptctl render-spec for {task_id}: {exc}",
        )
    if proc.returncode != 0:
        _emit_claim_error(
            "SNIPPET_RENDER_FAILED",
            f"promptctl render-spec exited {proc.returncode} for {task_id}",
            details={"stderr": (proc.stderr or "").strip()},
        )
    return proc.stdout


def _read_spec_md(data_dir: Path, spec_id: str) -> str:
    """Read the raw spec markdown for an epic/task id (mirrors run_cat.py).

    Missing spec → empty string (the briefing tolerates a spec-less entity;
    existence of the task JSON is already gated upstream).
    """
    spec_path = data_dir / "specs" / f"{spec_id}.md"
    if not spec_path.exists():
        return ""
    return spec_path.read_text(encoding="utf-8")


def run(args: SimpleNamespace) -> int:
    from planctl.ids import epic_id_from_task, is_task_id
    from planctl.invocation import build_planctl_invocation_readonly
    from planctl.models import merge_task_state
    from planctl.output import emit
    from planctl.runtime_status import _expected_worker_cwd
    from planctl.store import (
        LocalFileStateStore,
        get_actor,
        load_json,
        now_iso,
    )

    task_id: str = args.task_id
    force: bool = args.force
    note: str | None = args.note
    project: str | None = getattr(args, "project", None)

    # --- Precondition gate (all asserts BEFORE any mutation) ---

    # 1. validate id
    if not is_task_id(task_id):
        _emit_claim_error("BAD_TASK_ID", f"Invalid task ID: {task_id}")

    # 2. resolve owning project cwd-agnostically (roots discovery or --project
    #    override). Resolution requires the task JSON to exist, so step 3
    #    (task-exists) is subsumed here.
    ctx = _resolve_project_for_task(task_id, project)
    data_dir = ctx.data_dir
    state_store = LocalFileStateStore(ctx.state_dir)

    task_path = data_dir / "tasks" / f"{task_id}.json"
    task_def = load_json(task_path)
    actor = get_actor()

    # Load epic def (best-effort — used for target_repo resolution + briefing).
    epic_id = epic_id_from_task(task_id)
    epic_path = data_dir / "epics" / f"{epic_id}.json"
    epic_def: dict[str, Any] = load_json(epic_path) if epic_path.exists() else {}

    # 4. resolve target_repo / primary_repo (three-level fallback, realpath-normalized)
    proj_path = str(ctx.project_path)
    target_repo = str(
        Path(_expected_worker_cwd(task_def, epic_def, proj_path)).resolve()
    )
    primary_repo = str(Path(epic_def.get("primary_repo") or proj_path).resolve())

    # 5. status / deps gate — read current runtime state (no lock; the CAS below
    #    re-reads under the lock and is the authoritative decision point). This
    #    pre-check returns typed errors without acquiring the lock or mutating.
    runtime_pre = state_store.load_runtime(task_id)
    merged_pre = merge_task_state(task_def, runtime_pre)
    status_pre = merged_pre.get("status", "todo")

    if status_pre == "done":
        # TASK_DONE is never bypassed, even with --force.
        _emit_claim_error("TASK_DONE", f"Task {task_id} is already done")

    if not force:
        if status_pre == "blocked":
            _emit_claim_error("TASK_BLOCKED", f"Task {task_id} is blocked")

        if status_pre == "in_progress":
            current_assignee = merged_pre.get("assignee")
            if current_assignee and current_assignee != actor:
                _emit_claim_error(
                    "CLAIMED_BY_OTHER",
                    f"Task {task_id} is claimed by {current_assignee}",
                    details={"assignee": current_assignee},
                )

        deps = task_def.get("depends_on", [])
        if deps:
            tasks_dir = data_dir / "tasks"
            unmet: list[str] = []
            for dep_id in deps:
                dep_path = tasks_dir / f"{dep_id}.json"
                if dep_path.exists():
                    dep_runtime = state_store.load_runtime(dep_id)
                    dep_status = (dep_runtime or {}).get("status", "todo")
                    if dep_status != "done":
                        unmet.append(dep_id)
            if unmet:
                _emit_claim_error(
                    "DEPS_UNMET",
                    f"Unmet dependencies for {task_id}: {', '.join(unmet)}",
                    details={"unmet": unmet},
                )

    # --- Read-only briefing context (computed BEFORE the single mutation) ---

    task_spec_md = _read_spec_md(data_dir, task_id)
    epic_spec_md = _read_spec_md(data_dir, epic_id)
    tier = task_def.get("tier")
    # render-spec shells with cwd=primary_repo; non-zero exit aborts pre-CAS.
    snippet_context = _render_snippet_context(task_id, primary_repo)

    # --- CAS under lock: read-merge-decide-write in one lock ---

    with state_store.lock_task(task_id):
        runtime = state_store.load_runtime(task_id)
        merged = merge_task_state(task_def, runtime)
        status = merged.get("status", "todo")

        # Re-assert TASK_DONE inside the lock (defends against a concurrent
        # done landing between the pre-check and the lock acquire).
        if status == "done":
            _emit_claim_error("TASK_DONE", f"Task {task_id} is already done")

        existing_assignee = merged.get("assignee")
        already_mine = (
            status == "in_progress" and existing_assignee == actor and not force
        )

        if (
            not force
            and not already_mine
            and status == "in_progress"
            and existing_assignee
            and existing_assignee != actor
        ):
            _emit_claim_error(
                "CLAIMED_BY_OTHER",
                f"Task {task_id} is claimed by {existing_assignee}",
                details={"assignee": existing_assignee},
            )

        now = now_iso()
        claim_note = note or ""

        if already_mine:
            # Idempotent re-claim: preserve the original claimed_at + note.
            outcome = "ALREADY_MINE"
            claimed_at = merged.get("claimed_at", now)
            claim_note = merged.get("claim_note", claim_note)
        else:
            outcome = "CLAIMED"
            claimed_at = now
            if force and status == "in_progress":
                prev_assignee = merged.get("assignee")
                if prev_assignee and prev_assignee != actor:
                    claim_note = note or f"Taken over from {prev_assignee}"

        new_state: dict = {
            "status": "in_progress",
            "updated_at": now,
            "assignee": actor,
            "claimed_at": claimed_at,
            "claim_note": claim_note,
            "evidence": merged.get("evidence"),
            "blocked_reason": None,
        }
        state_store.save_runtime(task_id, new_state)

    task_state: dict[str, Any] = {
        "status": "in_progress",
        "assignee": actor,
        "claimed_at": new_state["claimed_at"],
        "claim_note": new_state["claim_note"],
        "outcome": outcome,
    }
    epic_state: dict[str, Any] = {
        "id": epic_id,
        "title": epic_def.get("title"),
        "status": epic_def.get("status"),
        "primary_repo": epic_def.get("primary_repo"),
        "touched_repos": epic_def.get("touched_repos", []),
    }

    pc = build_planctl_invocation_readonly("claim", task_id, repo_root=ctx.project_path)
    emit(
        {
            "task_id": task_id,
            "epic_id": epic_id,
            "target_repo": target_repo,
            "primary_repo": primary_repo,
            "tier": tier,
            "task_spec_md": task_spec_md,
            "epic_spec_md": epic_spec_md,
            "task_state": task_state,
            "epic_state": epic_state,
            "snippet_context": snippet_context,
        },
        planctl_invocation=pc,
    )
    return 0
