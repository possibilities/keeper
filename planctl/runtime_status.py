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

RuntimeStatus = Literal["complete", "untouched", "pending_approval"]

# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------


def _task_pending_approval(task: dict[str, Any]) -> bool:
    """Return True iff a task has a worker drain that has not been acked (fn-386).

    Predicate: ``worker_done_at is not None AND (worker_acked_at is None OR
    worker_acked_at < worker_done_at)``. Same-second collision (``==``) treats
    the ack as current (safe-fail toward complete).

    Pre-existing done tasks with no ``worker_done_at`` field set are
    grandfathered (returns False) — gate only applies to forward completions.
    Reads via ``dict.get`` so un-normalized records do not raise.
    """
    done_at = task.get("worker_done_at")
    if done_at is None:
        return False
    acked_at = task.get("worker_acked_at")
    if acked_at is None:
        return True
    return acked_at < done_at


def _epic_pending_approval(epic: dict[str, Any]) -> bool:
    """Return True iff an epic has a closer drain that has not been acked (fn-386).

    Predicate: ``closer_done_at is not None AND (closer_acked_at is None
    OR closer_acked_at < closer_done_at)``.

    fn-559 reverted the fn-521 ``auditor_done_at`` clause: the standalone
    auditor concept was torn down (the audit now runs inline inside
    ``/plan:close`` before the close mutation), so a closed epic flips
    straight to ``pending_approval`` once ``closer_done_at`` lands — there is
    no separate audit gate to satisfy first.

    Pre-existing closed epics with no ``closer_done_at`` field set are
    grandfathered (returns False).
    """
    done_at = epic.get("closer_done_at")
    if done_at is None:
        return False
    acked_at = epic.get("closer_acked_at")
    if acked_at is None:
        return True
    return acked_at < done_at


def _expected_worker_cwd(task: dict[str, Any], epic: dict[str, Any], proj: str) -> str:
    """Return the expected cwd for a worker dispatched for *task* in *epic*.

    Three-level fallback: task.target_repo → epic.primary_repo → proj.
    Handles legacy pre-fn-364 records where primary_repo may be null.
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
            if _task_pending_approval(task):  return "pending_approval"
            return "complete"
        return "untouched"

    Args:
        task: Task dict from the plans bundle (must have ``status``).
        epic: Epic dict from the plans bundle.  Accepted for call-shape
              parity with the per-bundle iteration in ``global_state.py``;
              not consumed in the collapsed predicate.
        proj: Absolute project path.  Accepted for the same parity reason.

    Returns:
        ``"complete"`` for done+acked tasks, ``"pending_approval"`` for
        done tasks awaiting a human ack, ``"untouched"`` for everything else
        (todo, in_progress, blocked).
    """
    # epic / proj retained in the signature for call-shape parity with the
    # per-bundle iteration loops in global_state.py — they're no longer read.
    del epic, proj
    status = task.get("status", "")
    if status == "done":
        if _task_pending_approval(task):
            return "pending_approval"
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

        # Pending-approval gate (fn-386).
        if epic.status == "done" and _epic_pending_approval(epic):
            return "pending_approval"

        # tasks_complete_all + status==done → complete.
        tasks_complete_all = bool(tasks) and all(
            task_statuses[t.id] == "complete" for t in tasks
        )
        if tasks_complete_all and epic.status == "done":
            return "complete"

        # Anything-touched fallthrough.
        if tasks and any(task_statuses[t.id] != "untouched" for t in tasks):
            return "wrapped" -> NO, plan-state only emits "untouched".
        return "untouched"

    Args:
        epic:          Epic dict from the plans bundle (must have ``id``, ``status``).
        tasks:         List of task dicts for this epic.
        proj:          Absolute project path.  Accepted for call-shape parity
                       with the per-bundle iteration in ``global_state.py``.
        task_statuses: Precomputed mapping of task_id → RuntimeStatus for this
                       epic's tasks (from ``derive_task_runtime_status``).

    Returns:
        ``"complete"``, ``"untouched"``, or ``"pending_approval"``.
    """
    del proj  # call-shape parity; not consumed

    # Discarded close (closer's own decision: "this epic was thrown away") is
    # terminal and self-acked — no human ack-gate needed.  Clears any
    # downstream dep gate immediately.
    if epic.get("status") == "done" and epic.get("close_reason") == "discarded":
        return "complete"

    # Pending-approval gate (fn-386).
    if epic.get("status") == "done" and _epic_pending_approval(epic):
        return "pending_approval"

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

    Resolution order (fn-600 task .2 — cross-project epic deps):

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
