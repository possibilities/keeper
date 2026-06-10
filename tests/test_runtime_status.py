"""Tests for planctl.runtime_status — plan-state-only derivation.

The derive functions read plan-state alone: a task is ``complete`` iff its
``status == "done"``, an epic is ``complete`` iff it is ``status == "done"``
with every task complete (or close_reason "discarded"), else ``untouched``.
There is no ``pending_approval`` state and no ack gate.
``derive_closer_runtime_status`` always returns ``None``.
"""

from __future__ import annotations

import pytest
from planctl.runtime_status import (
    RuntimeStatus,
    _dep_epics_runtime_complete,
    _expected_closer_cwd,
    _expected_worker_cwd,
    derive_closer_runtime_status,
    derive_epic_runtime_status,
    derive_task_runtime_status,
)

# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

PROJ = "/home/user/myproject"
PROJ2 = "/home/user/otherproject"


def _make_task(task_id: str, status: str = "todo", **extra: object) -> dict:
    row = {"id": task_id, "status": status}
    row.update(extra)
    return row


def _make_epic(epic_id: str, status: str = "open", **extra: object) -> dict:
    row = {"id": epic_id, "status": status}
    row.update(extra)
    return row


class _BoomOnAccess:
    """Tripwire sentinel: raises AssertionError on iteration.

    Used to prove the short-circuit invariant in
    ``_dep_epics_runtime_complete`` — if a dep-epic value at this key is
    never accessed, the helper short-circuited before reaching it.
    """

    def __iter__(self):
        raise AssertionError("short-circuit failed: second dep was accessed")


# ---------------------------------------------------------------------------
# derive_task_runtime_status — collapsed predicate
# ---------------------------------------------------------------------------


class TestTaskDone:
    def test_done_returns_complete(self):
        task = _make_task("fn-1-epic.1", status="done")
        assert derive_task_runtime_status(task, {}, PROJ) == "complete"

    def test_done_with_worker_done_at_returns_complete(self):
        """worker_done_at rides the JSON but does not gate the deriver."""
        task = _make_task(
            "fn-1-epic.1",
            status="done",
            worker_done_at="2026-01-01T00:00:00Z",
        )
        assert derive_task_runtime_status(task, {}, PROJ) == "complete"

    def test_done_no_worker_done_at_returns_complete(self):
        """A done task with no worker_done_at stamp is still complete."""
        task = _make_task("fn-1-epic.1", status="done")
        assert derive_task_runtime_status(task, {}, PROJ) == "complete"


class TestTaskNotDone:
    @pytest.mark.parametrize(
        "status",
        ["todo", "in_progress", "blocked"],
    )
    def test_non_done_status_returns_untouched(self, status: str):
        task = _make_task("fn-1-epic.1", status=status)
        assert derive_task_runtime_status(task, {}, PROJ) == "untouched"

    def test_empty_status_returns_untouched(self):
        task = {"id": "fn-1-epic.1"}
        assert derive_task_runtime_status(task, {}, PROJ) == "untouched"


# ---------------------------------------------------------------------------
# derive_epic_runtime_status — collapsed predicate
# ---------------------------------------------------------------------------


class TestEpicEmpty:
    def test_open_no_tasks_returns_untouched(self):
        epic = _make_epic("fn-1-epic")
        assert derive_epic_runtime_status(epic, [], PROJ, {}) == "untouched"

    def test_done_no_tasks_returns_untouched(self):
        """Done epic with zero tasks does not reach tasks_complete_all
        (bool(tasks) is False) and is not discarded → untouched."""
        epic = _make_epic("fn-1-epic", status="done")
        assert derive_epic_runtime_status(epic, [], PROJ, {}) == "untouched"


class TestEpicComplete:
    def test_all_tasks_complete_epic_done_returns_complete(self):
        epic = _make_epic("fn-1-epic", status="done")
        tasks = [_make_task("fn-1-epic.1", status="done")]
        task_statuses: dict[str, RuntimeStatus] = {"fn-1-epic.1": "complete"}
        assert (
            derive_epic_runtime_status(epic, tasks, PROJ, task_statuses) == "complete"
        )

    def test_done_epic_with_closer_done_at_returns_complete(self):
        """A closed-and-drained epic is complete the instant the closer
        finishes — no ack gate stands between closer_done_at and complete."""
        epic = _make_epic(
            "fn-1-epic",
            status="done",
            closer_done_at="2026-01-01T00:00:00Z",
        )
        task = _make_task("fn-1-epic.1", status="done")
        task_statuses: dict[str, RuntimeStatus] = {"fn-1-epic.1": "complete"}
        assert (
            derive_epic_runtime_status(epic, [task], PROJ, task_statuses) == "complete"
        )

    def test_open_epic_with_all_tasks_complete_returns_untouched(self):
        """tasks_complete_all but epic still open → not complete."""
        epic = _make_epic("fn-1-epic", status="open")
        tasks = [_make_task("fn-1-epic.1", status="done")]
        task_statuses: dict[str, RuntimeStatus] = {"fn-1-epic.1": "complete"}
        assert (
            derive_epic_runtime_status(epic, tasks, PROJ, task_statuses) == "untouched"
        )

    def test_done_epic_with_one_task_untouched_returns_untouched(self):
        epic = _make_epic("fn-1-epic", status="done")
        tasks = [
            _make_task("fn-1-epic.1", status="done"),
            _make_task("fn-1-epic.2", status="todo"),
        ]
        task_statuses: dict[str, RuntimeStatus] = {
            "fn-1-epic.1": "complete",
            "fn-1-epic.2": "untouched",
        }
        assert (
            derive_epic_runtime_status(epic, tasks, PROJ, task_statuses) == "untouched"
        )


class TestEpicDiscardedShortCircuit:
    """Discarded close (terminal) short-circuits to complete."""

    def test_discarded_taskless_returns_complete(self):
        epic = _make_epic(
            "fn-1-discarded",
            status="done",
            close_reason="discarded",
            closer_done_at="2026-01-01T00:00:00Z",
        )
        assert derive_epic_runtime_status(epic, [], PROJ, {}) == "complete"

    def test_discarded_with_unfinished_tasks_returns_complete(self):
        """Discarded epic with leftover tasks still short-circuits."""
        epic = _make_epic(
            "fn-1-discarded",
            status="done",
            close_reason="discarded",
        )
        task = _make_task("fn-1-discarded.1", status="todo")
        task_statuses: dict[str, RuntimeStatus] = {"fn-1-discarded.1": "untouched"}
        assert (
            derive_epic_runtime_status(epic, [task], PROJ, task_statuses) == "complete"
        )

    def test_open_discarded_does_not_short_circuit(self):
        """Guard: status must be 'done' for the early return to fire."""
        epic = _make_epic(
            "fn-1-discarded",
            status="open",
            close_reason="discarded",
        )
        assert derive_epic_runtime_status(epic, [], PROJ, {}) == "untouched"


# ---------------------------------------------------------------------------
# derive_closer_runtime_status — always None in the plan-state-only model
# ---------------------------------------------------------------------------


class TestCloserRuntimeStatus:
    def test_returns_none_for_open_epic(self):
        epic = _make_epic("fn-1-epic", status="open")
        assert derive_closer_runtime_status(epic, PROJ) is None

    def test_returns_none_for_done_epic(self):
        epic = _make_epic("fn-1-epic", status="done")
        assert derive_closer_runtime_status(epic, PROJ) is None

    def test_returns_none_for_discarded_epic(self):
        epic = _make_epic("fn-1-epic", status="done", close_reason="discarded")
        assert derive_closer_runtime_status(epic, PROJ) is None


# ---------------------------------------------------------------------------
# _expected_worker_cwd / _expected_closer_cwd — three-level fallback
# ---------------------------------------------------------------------------


class TestExpectedWorkerCwd:
    def test_task_target_repo_wins(self):
        task = {"target_repo": "/t"}
        epic = {"primary_repo": "/p"}
        assert _expected_worker_cwd(task, epic, "/proj") == "/t"

    def test_epic_primary_repo_when_task_target_repo_absent(self):
        task: dict = {}
        epic = {"primary_repo": "/p"}
        assert _expected_worker_cwd(task, epic, "/proj") == "/p"

    def test_falls_through_to_proj(self):
        task: dict = {}
        epic: dict = {}
        assert _expected_worker_cwd(task, epic, "/proj") == "/proj"

    def test_null_target_falls_through(self):
        task = {"target_repo": None}
        epic = {"primary_repo": None}
        assert _expected_worker_cwd(task, epic, "/proj") == "/proj"


class TestExpectedCloserCwd:
    def test_epic_primary_repo_wins(self):
        epic = {"primary_repo": "/p"}
        assert _expected_closer_cwd(epic, "/proj") == "/p"

    def test_falls_through_to_proj(self):
        epic: dict = {}
        assert _expected_closer_cwd(epic, "/proj") == "/proj"

    def test_null_primary_falls_through(self):
        epic = {"primary_repo": None}
        assert _expected_closer_cwd(epic, "/proj") == "/proj"


# ---------------------------------------------------------------------------
# _dep_epics_runtime_complete — same-project + cross-project resolution
# ---------------------------------------------------------------------------


class TestDepEpicsRuntimeComplete:
    """Fail-closed invariant: a dep id absent from both lookups is not-complete."""

    @pytest.mark.parametrize(
        "epic_deps, dep_epic_lookup, expected",
        [
            pytest.param(
                [],
                {},
                True,
                id="empty_list",
            ),
            pytest.param(
                ["fn-99-missing"],
                {},
                False,
                id="missing_dep_id",
            ),
            pytest.param(
                ["fn-1-dep"],
                {
                    (PROJ, "fn-1-dep"): (
                        {"id": "fn-1-dep", "status": "done"},
                        [{"id": "fn-1-dep.1", "status": "done"}],
                    )
                },
                True,
                id="complete_dep",
            ),
            pytest.param(
                ["fn-1-dep"],
                {
                    (PROJ, "fn-1-dep"): (
                        {"id": "fn-1-dep", "status": "open"},
                        [{"id": "fn-1-dep.1", "status": "todo"}],
                    )
                },
                False,
                id="incomplete_dep",
            ),
            pytest.param(
                ["fn-1-incomplete", "fn-2-tripwire"],
                {
                    (PROJ, "fn-1-incomplete"): (
                        {"id": "fn-1-incomplete", "status": "open"},
                        [{"id": "fn-1-incomplete.1", "status": "todo"}],
                    ),
                    (PROJ, "fn-2-tripwire"): _BoomOnAccess(),
                },
                False,
                id="short_circuit_skips_second_dep",
            ),
            pytest.param(
                ["fn-1-incomplete", "fn-2-complete"],
                {
                    (PROJ, "fn-1-incomplete"): (
                        {"id": "fn-1-incomplete", "status": "open"},
                        [{"id": "fn-1-incomplete.1", "status": "todo"}],
                    ),
                    (PROJ, "fn-2-complete"): (
                        {"id": "fn-2-complete", "status": "done"},
                        [{"id": "fn-2-complete.1", "status": "done"}],
                    ),
                },
                False,
                id="mixed_incomplete_first",
            ),
            pytest.param(
                ["fn-1-complete", "fn-2-incomplete"],
                {
                    (PROJ, "fn-1-complete"): (
                        {"id": "fn-1-complete", "status": "done"},
                        [{"id": "fn-1-complete.1", "status": "done"}],
                    ),
                    (PROJ, "fn-2-incomplete"): (
                        {"id": "fn-2-incomplete", "status": "open"},
                        [{"id": "fn-2-incomplete.1", "status": "todo"}],
                    ),
                },
                False,
                id="mixed_complete_first",
            ),
        ],
    )
    def test_dep_epics_runtime_complete(
        self,
        epic_deps: list[str],
        dep_epic_lookup: dict,
        expected: bool,
    ) -> None:
        result = _dep_epics_runtime_complete(epic_deps, PROJ, dep_epic_lookup)
        assert result is expected


class TestDepEpicsRuntimeCompleteOnClose:
    """A closed-and-drained dep epic is runtime-complete immediately."""

    def test_dep_closer_done_at_returns_complete(self):
        dep_epic = _make_epic(
            "fn-1-dep",
            status="done",
            closer_done_at="2026-01-01T00:00:00Z",
        )
        dep_task = _make_task("fn-1-dep.1", status="done")
        dep_epic_lookup: dict[tuple[str, str], tuple[dict, list[dict]]] = {
            (PROJ, "fn-1-dep"): (dep_epic, [dep_task])
        }
        assert _dep_epics_runtime_complete(["fn-1-dep"], PROJ, dep_epic_lookup) is True

    def test_dep_open_blocks_complete(self):
        dep_epic = _make_epic("fn-1-dep", status="open")
        dep_task = _make_task("fn-1-dep.1", status="todo")
        dep_epic_lookup: dict[tuple[str, str], tuple[dict, list[dict]]] = {
            (PROJ, "fn-1-dep"): (dep_epic, [dep_task])
        }
        assert _dep_epics_runtime_complete(["fn-1-dep"], PROJ, dep_epic_lookup) is False


class TestDepEpicsCrossProjectFallback:
    """dep_epic_by_id supplies the cross-project fallback."""

    def test_cross_project_resolved_done_returns_true(self):
        dep_epic = _make_epic("fn-1-dep", status="done")
        dep_task = _make_task("fn-1-dep.1", status="done")
        # Same-project lookup empty; cross-project overlay carries the dep.
        dep_epic_lookup: dict[tuple[str, str], tuple[dict, list[dict]]] = {}
        dep_epic_by_id: dict[str, tuple[str, dict, list[dict]]] = {
            "fn-1-dep": (PROJ2, dep_epic, [dep_task])
        }
        assert (
            _dep_epics_runtime_complete(
                ["fn-1-dep"], PROJ, dep_epic_lookup, dep_epic_by_id
            )
            is True
        )

    def test_cross_project_resolved_open_returns_false(self):
        dep_epic = _make_epic("fn-1-dep", status="open")
        dep_task = _make_task("fn-1-dep.1", status="todo")
        dep_epic_lookup: dict[tuple[str, str], tuple[dict, list[dict]]] = {}
        dep_epic_by_id: dict[str, tuple[str, dict, list[dict]]] = {
            "fn-1-dep": (PROJ2, dep_epic, [dep_task])
        }
        assert (
            _dep_epics_runtime_complete(
                ["fn-1-dep"], PROJ, dep_epic_lookup, dep_epic_by_id
            )
            is False
        )

    def test_dangling_dep_returns_false(self):
        """Neither same-project nor cross-project resolution → False."""
        dep_epic_lookup: dict[tuple[str, str], tuple[dict, list[dict]]] = {}
        dep_epic_by_id: dict[str, tuple[str, dict, list[dict]]] = {}
        assert (
            _dep_epics_runtime_complete(
                ["fn-99-dangling"], PROJ, dep_epic_lookup, dep_epic_by_id
            )
            is False
        )

    def test_same_project_wins_over_cross_project_overlay(self):
        """Same-project entry takes precedence over cross-project overlay."""
        same_proj_epic = _make_epic("fn-1-dep", status="done")
        same_proj_task = _make_task("fn-1-dep.1", status="done")
        # Cross-project overlay has the same id but with status=open.  Same-
        # project resolution must win, so the dep is complete.
        cross_proj_epic = _make_epic("fn-1-dep", status="open")
        cross_proj_task = _make_task("fn-1-dep.1", status="todo")
        dep_epic_lookup: dict[tuple[str, str], tuple[dict, list[dict]]] = {
            (PROJ, "fn-1-dep"): (same_proj_epic, [same_proj_task])
        }
        dep_epic_by_id: dict[str, tuple[str, dict, list[dict]]] = {
            "fn-1-dep": (PROJ2, cross_proj_epic, [cross_proj_task])
        }
        assert (
            _dep_epics_runtime_complete(
                ["fn-1-dep"], PROJ, dep_epic_lookup, dep_epic_by_id
            )
            is True
        )
