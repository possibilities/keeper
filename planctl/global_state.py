"""Pure derivation module for cross-project workable-task state.

Consumes the ``plans`` snapshot keeped by external observers
(``<project_path>::<epic_id>`` → bundle) and derives the workable /
close-ready / in-progress / blocked-epics projection.

No I/O, no logging, no clock.  All functions are deterministic given the
same input dict.
"""

from __future__ import annotations

import shlex
from typing import Any

from planctl.ids import parse_id
from planctl.runtime_status import (
    _dep_epics_runtime_complete,
    _expected_closer_cwd,
    _expected_worker_cwd,
    derive_task_runtime_status,
)

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _epic_sort_key(epic_id: str) -> int:
    """Return the numeric prefix of an epic id for sort ordering."""
    num, _ = parse_id(epic_id)
    return num if num is not None else 0


def _open_bundles_sorted(
    plans: dict[str, Any],
) -> list[tuple[str, dict[str, Any]]]:
    """Return (project_path, bundle) for every open epic across all projects.

    Ordered by plain numeric epic prefix asc within each project, then by
    project path asc across projects.  Lookup is per-(project_path, epic_id);
    no cross-project leaks.
    """
    by_project: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    for key, bundle in plans.items():
        if not isinstance(key, str) or "::" not in key:
            continue
        proj, _, _ = key.partition("::")
        epic = (bundle or {}).get("epic") or {}
        if epic.get("status") != "open":
            continue
        eid = epic.get("id")
        if not isinstance(eid, str):
            continue
        by_project.setdefault(proj, []).append((eid, bundle))

    result: list[tuple[str, dict[str, Any]]] = []
    for proj in sorted(by_project):
        items = by_project[proj]
        items.sort(key=lambda eb: _epic_sort_key(eb[0]))
        for _eid, bundle in items:
            result.append((proj, bundle))

    return result


def _in_progress_items(plans: dict[str, Any]) -> list[dict[str, Any]]:
    """Return in_progress rows as tagged dicts — stable order.

    Each row is a tagged union with ``kind`` as discriminant.  In the
    plan-state-only model only ``"task"`` rows surface — emitted when
    ``task.status == "in_progress"``.  No ``"close"`` rows are emitted
    because the deriver has no view into running closers.
    """
    out: list[dict[str, Any]] = []
    for proj, b in _open_bundles_sorted(plans):
        epic = b.get("epic") or {}
        for t in b.get("tasks") or []:
            tid = t.get("id")
            if not isinstance(tid, str):
                continue
            if t.get("status") == "in_progress":
                out.append(
                    {
                        "kind": "task",
                        "proj": proj,
                        "id": tid,
                        "status": None,
                        "target_repo": t.get("target_repo") or None,
                        "primary_repo": epic.get("primary_repo") or None,
                    }
                )
    return out


def _compute_workable_tasks(
    plans: dict[str, Any],
) -> tuple[
    list[dict[str, str | None]],
    list[dict[str, str | None]],
    list[dict[str, str | None]],
    dict[str, dict[str, list[str]]],
]:
    """Derive workable tasks, close-ready epics, and blocked epics.

    Returns ``(workable, close_ready, ordered_items, blocked_epics)`` where:

    - ``workable`` — todo tasks with met epic-deps and met task-deps.
      Each row: {proj, action_id, label, prompt, command, target_repo,
      primary_repo, touched_repos}.
    - ``close_ready`` — open epics whose every task is ``status=="done"``.
      Each row: {proj, action_id, label, prompt, command, primary_repo,
      touched_repos}.
    - ``ordered_items`` — workable tasks and close-ready entries combined in
      their natural epic-grouped order (tasks first within each epic, close
      item appended after).  Used by renderers that need the original flat list.
    - ``blocked_epics`` — dict keyed ``<project>::<epic_id>`` → inner dict
      ``{"blocked_pending": [...], "blocked_dangling": [...]}``.
      ``blocked_pending`` carries dep ids that resolved (same-
      project or cross-project via the ``by_id`` overlay) but whose dep epic
      is not yet runtime-complete.  ``blocked_dangling`` carries dep ids that
      resolved nowhere.  Only epics with at least one unmet dep appear.
    """
    # Build per-project status maps — ids are not unique across projects.
    # task_lookup maps (proj, task_id) → (task_dict, epic_dict) so the dep
    # gate can call derive_task_runtime_status without a second scan.  Iterate
    # ALL bundles (open + done) so cross-epic deps within the same project and
    # deps into closed epics resolve.
    # dep_epic_by_id maps epic_id → (owner_proj, epic_dict, tasks_list) — the
    # cross-project fallback overlay.
    epic_status: dict[tuple[str, str], str] = {}
    task_lookup: dict[tuple[str, str], tuple[dict[str, Any], dict[str, Any]]] = {}
    dep_epic_lookup: dict[
        tuple[str, str], tuple[dict[str, Any], list[dict[str, Any]]]
    ] = {}
    dep_epic_by_id: dict[str, tuple[str, dict[str, Any], list[dict[str, Any]]]] = {}
    for key, bundle in plans.items():
        if not isinstance(key, str) or "::" not in key:
            continue
        proj, _, _ = key.partition("::")
        ep = (bundle or {}).get("epic") or {}
        eid = ep.get("id")
        tasks_list: list[dict[str, Any]] = (bundle or {}).get("tasks") or []
        if isinstance(eid, str):
            epic_status[(proj, eid)] = ep.get("status", "")
            dep_epic_lookup[(proj, eid)] = (ep, tasks_list)
            dep_epic_by_id[eid] = (proj, ep, tasks_list)
        for t in tasks_list:
            tid = t.get("id")
            if isinstance(tid, str):
                task_lookup[(proj, tid)] = (t, ep)

    workable: list[dict[str, str | None]] = []
    close_ready: list[dict[str, str | None]] = []
    ordered_items: list[dict[str, str | None]] = []
    blocked_epics: dict[str, dict[str, list[str]]] = {}

    def _dep_status(dep_proj: str, dep_id: str) -> str:
        """Classify a single dep id as ``done`` / ``pending`` / ``dangling``."""
        same = epic_status.get((dep_proj, dep_id))
        if same is not None:
            return "done" if same == "done" else "pending"
        if dep_id in dep_epic_by_id:
            _owner_proj, owner_ep, _ = dep_epic_by_id[dep_id]
            return "done" if owner_ep.get("status") == "done" else "pending"
        return "dangling"

    for proj, b in _open_bundles_sorted(plans):
        epic = b.get("epic") or {}
        eid = epic.get("id", "?")

        # Unvalidated epics are not actionable — hide from all three buckets.
        if epic.get("last_validated_at") is None:
            continue

        epic_deps = epic.get("depends_on_epics") or []

        # blocked_epics: classify every dep against the same-project +
        # cross-project resolver.
        blocked_pending: list[str] = []
        blocked_dangling: list[str] = []
        for d in epic_deps:
            status = _dep_status(proj, d)
            if status == "pending":
                blocked_pending.append(d)
            elif status == "dangling":
                blocked_dangling.append(d)

        if blocked_pending or blocked_dangling:
            blocked_epics[f"{proj}::{eid}"] = {
                "blocked_pending": sorted(blocked_pending),
                "blocked_dangling": sorted(blocked_dangling),
            }
            # Epic is blocked — skip workable/close-ready derivation.
            continue

        # Cross-epic dep gate: a dep epic is satisfied only when
        # derive_epic_runtime_status == "complete".
        # dep_epic_by_id supplies the cross-project fallback.
        if not _dep_epics_runtime_complete(
            epic_deps, proj, dep_epic_lookup, dep_epic_by_id
        ):
            continue

        tasks = b.get("tasks") or []

        # Dep gate: a depends_on entry is satisfied only when
        # derive_task_runtime_status(dep_task, dep_epic, proj) == "complete".
        # A dep id with no task_lookup resolution is treated as not-complete
        # (hidden).
        for t in tasks:
            if t.get("status") != "todo":
                continue
            task_deps = t.get("depends_on") or []
            if not all(
                (proj, d) in task_lookup
                and derive_task_runtime_status(*task_lookup[(proj, d)], proj)
                == "complete"
                for d in task_deps
            ):
                continue
            tid = t.get("id", "?")
            ttitle = t.get("title") or ""
            expected_worker_cwd = _expected_worker_cwd(t, epic, proj)
            worker_quoted = shlex.quote(expected_worker_cwd)
            row: dict[str, str | None] = {
                "proj": proj,
                "action_id": tid,
                "label": ttitle,
                "prompt": f"/plan:work {tid}",
                "command": f'cd {worker_quoted} && claude "/plan:work {tid}"',
                "target_repo": t.get("target_repo") or None,
                "primary_repo": epic.get("primary_repo") or None,
                "touched_repos": epic.get("touched_repos") or None,
            }
            workable.append(row)
            ordered_items.append(row)

        if tasks and all(t.get("status") == "done" for t in tasks):
            etitle = epic.get("title") or ""
            label = f"close: {etitle}" if etitle else "close epic"
            expected_closer_cwd = _expected_closer_cwd(epic, proj)
            closer_quoted = shlex.quote(expected_closer_cwd)
            row = {
                "proj": proj,
                "action_id": eid,
                "label": label,
                "prompt": f"/plan:close {eid}",
                "command": f'cd {closer_quoted} && claude "/plan:close {eid}"',
                "primary_repo": epic.get("primary_repo") or None,
                "touched_repos": epic.get("touched_repos") or None,
            }
            close_ready.append(row)
            ordered_items.append(row)

    # Sort blocked_epics by key asc (project::epic_id)
    blocked_epics = dict(sorted(blocked_epics.items()))

    return workable, close_ready, ordered_items, blocked_epics


# ---------------------------------------------------------------------------
# Public surface
# ---------------------------------------------------------------------------


def derive_global_state(plans: dict[str, Any]) -> dict[str, Any]:
    """Derive the four-key workable-state dict from a plans bundle.

    Args:
        plans: Plans dict keyed ``<project_path>::<epic_id>`` → bundle.

    Returns:
        ::

            {
                "in_progress":   [
                    {"kind": "task",  "proj": ..., "id": ..., "status": None},
                    ...
                ],
                "workable":      [{"proj": ..., "action_id": ..., "label": ..., "prompt": ..., "command": ...}, ...],
                "close_ready":   [{"proj": ..., "action_id": ..., "label": ..., "prompt": ..., "command": ...}, ...],
                "ordered_items": [{"proj": ..., "action_id": ..., "label": ..., "prompt": ..., "command": ...}, ...],
                "blocked_epics": {
                    "<proj>::<eid>": {
                        "blocked_pending":  ["<dep_id>", ...],
                        "blocked_dangling": ["<dep_id>", ...],
                    },
                    ...
                },
            }

    Only ``"task"`` rows appear in ``in_progress`` — emitted when a task's
    plan-state is ``in_progress``.  No closer rows are emitted in the
    plan-state-only model.

    ``workable`` contains only todo-task rows; ``close_ready`` contains only
    close-epic rows.  Both are ordered by (project asc, numeric epic prefix
    asc, task-list position).  ``ordered_items`` merges them in the natural
    epic-grouped order.

    All lists are sorted deterministically so full-dict ``==`` dedupe is
    order-meaningful.
    """
    in_progress = _in_progress_items(plans)
    workable, close_ready, ordered_items, blocked_epics = _compute_workable_tasks(plans)
    return {
        "in_progress": in_progress,
        "workable": workable,
        "close_ready": close_ready,
        "ordered_items": ordered_items,
        "blocked_epics": blocked_epics,
    }


def apply_plans_event(plans: dict[str, Any], env: dict[str, Any]) -> bool:
    """Interpret an event envelope and mutate ``plans`` in place.

    Handles three envelope types:

    - ``type=="snapshot"``: full-replacement of the ``plans`` namespace.
      Reads ``env["state"]["plans"]`` and clears-then-updates the dict.
      Missing ``state`` or ``state["plans"]`` keys are tolerated silently
      (permissive-shape idiom — snapshots carry many namespaces planctl
      does not consume).  Returns ``True`` only when the dict actually
      changed (preserves the live-loop debounce).
    - ``type=="event", event=="plans_updated"``: inserts/updates one key.
    - ``type=="event", event=="plans_removed"``: removes one key.

    All other envelopes (``boot_status``, wrong namespace, etc.) are
    silently ignored and return ``False``.

    Args:
        plans: The plans dict to mutate.
        env:   A decoded event envelope dict.

    Returns:
        ``True`` iff ``plans`` actually changed.
    """
    if env.get("type") == "snapshot":
        state = env.get("state")
        if not isinstance(state, dict):
            return False
        new_plans = state.get("plans")
        if not isinstance(new_plans, dict):
            return False
        if plans == new_plans:
            return False
        plans.clear()
        plans.update(new_plans)
        return True
    if env.get("type") != "event" or env.get("namespace") != "plans":
        return False
    key = env.get("key")
    if not isinstance(key, str):
        return False
    ev = env.get("event")
    if ev == "plans_updated":
        row = env.get("row")
        if isinstance(row, dict):
            plans[key] = row
            return True
    elif ev == "plans_removed":
        plans.pop(key, None)
        return True
    return False
