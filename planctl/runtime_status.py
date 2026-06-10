"""Runtime status overlay — pure helpers, no I/O.

Derives a ``RuntimeStatus`` for each task and epic from the per-task plan
bundle alone.  Plan-state is the sole input; there is no job/subagent
overlay.  All functions are deterministic given the same input dicts.
Mirrors ``global_state.py`` discipline.
"""

from __future__ import annotations

from typing import Any, Literal

# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

RuntimeStatus = Literal["complete", "untouched"]

# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------


def _expected_worker_cwd(task: dict[str, Any], epic: dict[str, Any], proj: str) -> str:
    """Return the expected cwd for a worker dispatched for *task* in *epic*.

    Three-level fallback: task.target_repo → epic.primary_repo → proj.
    Handles records where primary_repo may be null.
    """
    return task.get("target_repo") or epic.get("primary_repo") or proj


def _expected_closer_cwd(epic: dict[str, Any], proj: str) -> str:
    """Return the expected cwd for a closer dispatched for *epic*.

    Two-level fallback: epic.primary_repo → proj.
    """
    return epic.get("primary_repo") or proj


def derive_task_runtime_status(
    task: dict[str, Any],
    epic: dict[str, Any],
    proj: str,
) -> RuntimeStatus:
    """Derive runtime status for a single task — plan-state only.

    Predicate:

        if task["status"] == "done":
            return "complete"
        return "untouched"

    Work auto-completes the instant the worker finishes: a ``done`` task is
    ``complete`` directly off ``status``. ``worker_done_at`` still rides the
    tracked task JSON (keeper's completion signal), but the deriver no longer
    gates on it.

    Args:
        task: Task dict from the plans bundle (must have ``status``).
        epic: Epic dict from the plans bundle.  Accepted for call-shape
              parity with the per-bundle iteration in ``global_state.py``;
              not consumed in the collapsed predicate.
        proj: Absolute project path.  Accepted for the same parity reason.

    Returns:
        ``"complete"`` for done tasks, ``"untouched"`` for everything else
        (todo, in_progress, blocked).
    """
    # epic / proj retained in the signature for call-shape parity with the
    # per-bundle iteration loops in global_state.py — they're no longer read.
    del epic, proj
    status = task.get("status", "")
    if status == "done":
        return "complete"
    return "untouched"


def derive_epic_runtime_status(
    epic: dict[str, Any],
    tasks: list[dict[str, Any]],
    proj: str,
    task_statuses: dict[str, RuntimeStatus],
) -> RuntimeStatus:
    """Derive runtime status for an epic — plan-state only.

    Predicate:

        # Discarded close short-circuit (closer self-acked, no human gate).
        if epic.status == "done" and epic.close_reason == "discarded":
            return "complete"

        # tasks_complete_all + status==done → complete.
        tasks_complete_all = bool(tasks) and all(
            task_statuses[t.id] == "complete" for t in tasks
        )
        if tasks_complete_all and epic.status == "done":
            return "complete"

        return "untouched"

    Args:
        epic:          Epic dict from the plans bundle (must have ``id``, ``status``).
        tasks:         List of task dicts for this epic.
        proj:          Absolute project path.  Accepted for call-shape parity
                       with the per-bundle iteration in ``global_state.py``.
        task_statuses: Precomputed mapping of task_id → RuntimeStatus for this
                       epic's tasks (from ``derive_task_runtime_status``).

    Returns:
        ``"complete"`` or ``"untouched"``.
    """
    del proj  # call-shape parity; not consumed

    # Discarded close (closer's own decision: "this epic was thrown away") is
    # terminal — it clears any downstream dep gate immediately, even when the
    # epic shipped no tasks.
    if epic.get("status") == "done" and epic.get("close_reason") == "discarded":
        return "complete"

    tasks_complete_all = bool(tasks) and all(
        task_statuses.get(t.get("id", "")) == "complete" for t in tasks
    )
    if tasks_complete_all and epic.get("status") == "done":
        return "complete"

    return "untouched"


def derive_closer_runtime_status(
    epic: dict[str, Any],
    proj: str,
) -> Literal["running", "wrapped"] | None:
    """Closer-only runtime status — always None in the plan-state-only model.

    Retained for call-shape parity with the prior signature.  Closer jobs
    no longer participate in the readiness gate; the planctl deriver has
    no view into running processes.
    """
    del epic, proj
    return None


def _dep_epics_runtime_complete(
    epic_deps: list[str],
    proj: str,
    dep_epic_lookup: dict[tuple[str, str], tuple[dict[str, Any], list[dict[str, Any]]]],
    dep_epic_by_id: dict[str, tuple[str, dict[str, Any], list[dict[str, Any]]]]
    | None = None,
) -> bool:
    """Return True when every dep epic is runtime-complete; missing dep treated as not-complete.

    A dep id absent from both ``dep_epic_lookup`` (same-project) and the
    optional ``dep_epic_by_id`` (cross-project) overlay is not-complete (no
    defensive default — missing id must return False explicitly).
    Short-circuits on first incomplete dep.

    Resolution order (cross-project epic deps):

    1. Same-project lookup via ``dep_epic_lookup[(proj, dep_id)]`` — wins
       when an epic with the same id exists in the same project.
    2. Cross-project fallback via ``dep_epic_by_id[dep_id]`` — fires when
       the same-project lookup misses AND the overlay is supplied.
    3. Dangling — neither resolves; returned as not-complete (False).

    Callers that have no roots-config / single-project deployments pass
    ``dep_epic_by_id=None`` and inherit the original same-project-only
    semantics bit-identically.
    """
    for dep_id in epic_deps:
        if (proj, dep_id) in dep_epic_lookup:
            dep_epic, dep_tasks = dep_epic_lookup[(proj, dep_id)]
            owner_proj = proj
        elif dep_epic_by_id is not None and dep_id in dep_epic_by_id:
            owner_proj, dep_epic, dep_tasks = dep_epic_by_id[dep_id]
        else:
            return False
        task_statuses: dict[str, RuntimeStatus] = {
            t.get("id", ""): derive_task_runtime_status(t, dep_epic, owner_proj)
            for t in dep_tasks
            if isinstance(t.get("id"), str)
        }
        if (
            derive_epic_runtime_status(dep_epic, dep_tasks, owner_proj, task_statuses)
            != "complete"
        ):
            return False
    return True
