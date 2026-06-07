"""Public Python API for cross-CLI planctl calls.

Import from here instead of shelling out or importing run_show internals.
Functions return Python objects; callers handle retry/skip on exceptions.
Never calls resolve_project() — callers construct ProjectContext directly so
this module is safe to import outside a planctl git root.

This module is the **only** legal cross-CLI import surface for planctl
(enforced by ``scripts/lint-cli-boundaries.py``). Sibling CLIs that need
helpers from ``acks``, ``ids``, or ``runtime_status``
import them via this façade — never directly.
"""

from __future__ import annotations

import json
from typing import Any

from planctl import acks
from planctl.ids import ID_REGEX, JOB_ID_REGEX, is_epic_id, is_job_id, is_task_id
from planctl.models import (
    RUNTIME_FIELDS,
    merge_epic_state,
    merge_task_state,
    normalize_epic,
    normalize_task,
)
from planctl.project import ProjectContext

# The wrappers below intentionally look the canonical helpers up on their
# owning module **at call time** rather than capturing them at import time.
# The cli-boundaries lint forces cross-CLI callers through this façade, but
# a chunk of the existing test surface monkey-patches the canonical names
# on their owning module (e.g.
# ``planctl.runtime_status._expected_closer_cwd``). Direct
# ``from X import Y as Z`` re-exports would shadow the patch; deferred
# attribute lookup keeps the test contract intact.


def epic_id_from_task(task_id: str) -> str:
    """Façade over :func:`planctl.ids.epic_id_from_task`."""
    from planctl import ids

    return ids.epic_id_from_task(task_id)


def expected_closer_cwd(epic: dict[str, Any], proj: str) -> str:
    """Façade over ``planctl.runtime_status._expected_closer_cwd``."""
    from planctl import runtime_status

    return runtime_status._expected_closer_cwd(epic, proj)


def expected_worker_cwd(task: dict[str, Any], epic: dict[str, Any], proj: str) -> str:
    """Façade over ``planctl.runtime_status._expected_worker_cwd``."""
    from planctl import runtime_status

    return runtime_status._expected_worker_cwd(task, epic, proj)


def load_epic(project: ProjectContext, epic_id: str) -> dict:
    """Load an epic definition with its runtime sidecar merged in.

    Returns the merged epic dict. Raises ``FileNotFoundError`` if the
    epic file is absent or ``json.JSONDecodeError`` on a half-written /
    malformed file. Callers handle the retry/skip decision.

    The only runtime field an epic carries is ``approval`` (fn-732), held in
    the gitignored ``state/epics/<id>.state.json`` sidecar. ``merge_epic_state``
    resolves it via the sidecar > def > pending ladder so callers reading the
    returned dict's ``approval`` always get the canonical value.
    """
    from planctl.store import LocalFileStateStore

    epic_path = project.data_dir / "epics" / f"{epic_id}.json"
    data = json.loads(epic_path.read_text())
    state_store = LocalFileStateStore(project.state_dir)
    runtime = state_store.load_epic_runtime(epic_id)
    return merge_epic_state(data, runtime)


def load_tasks_for_epic(project: ProjectContext, epic_id: str) -> list[dict]:
    """Load all task definitions for an epic, with runtime state merged in.

    Enumerates tasks/<epic_id>.N.json files, merges runtime state for each,
    and returns the list unsorted. Use task_sort_key() to order the result.
    Returns ``[]`` only when the ``tasks/`` directory itself is absent.
    Raises ``FileNotFoundError`` / ``json.JSONDecodeError`` on a per-file
    race or half-write — caller retries the whole call.
    """
    from planctl.store import LocalFileStateStore

    tasks_dir = project.data_dir / "tasks"
    if not tasks_dir.exists():
        return []

    state_store = LocalFileStateStore(project.state_dir)
    tasks: list[dict] = []

    for f in tasks_dir.glob(f"{epic_id}.*.json"):
        td = json.loads(f.read_text())
        tid = td.get("id", f.stem)
        runtime = state_store.load_runtime(tid)
        tasks.append(merge_task_state(td, runtime))

    return tasks


def load_runtime(project: ProjectContext, task_id: str) -> dict | None:
    """Load runtime state for a task.

    Returns the runtime dict, or None if no runtime state file exists.
    An absent file is not an error — it means the task has never been started.
    """
    from planctl.store import LocalFileStateStore

    state_store = LocalFileStateStore(project.state_dir)
    return state_store.load_runtime(task_id)


def task_sort_key(task_id: str) -> tuple:
    """Return a sort key tuple for ordering tasks within an epic.

    Extracts the numeric task suffix from the id (e.g. "fn-1-slug.3" → 3).
    Unknown / unparseable ids sort last at 999.
    """
    from planctl.ids import parse_id

    _, tn = parse_id(task_id)
    return (tn if tn is not None else 999,)


__all__ = [
    "ID_REGEX",
    "JOB_ID_REGEX",
    "ProjectContext",
    "RUNTIME_FIELDS",
    "acks",
    "epic_id_from_task",
    "expected_closer_cwd",
    "expected_worker_cwd",
    "is_epic_id",
    "is_job_id",
    "is_task_id",
    "load_epic",
    "load_runtime",
    "load_tasks_for_epic",
    "merge_epic_state",
    "merge_task_state",
    "normalize_epic",
    "normalize_task",
    "task_sort_key",
]
