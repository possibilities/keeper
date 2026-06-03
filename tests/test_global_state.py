"""Tests for planctl.global_state — plan-state-only derivation.

The fn-614 collapse removed the ``jobs`` parameter and every join with
running-job data.  ``derive_global_state`` now reads plan-state alone —
``in_progress`` rows surface from ``task.status == "in_progress"``,
``workable``/``close_ready`` from plan-state alone, and the dep gate
delegates to ``derive_*_runtime_status`` (plan-state).
"""

from __future__ import annotations

import copy
import shlex

from planctl.global_state import (
    apply_plans_event,
    derive_global_state,
)

# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------


def _make_bundle(
    epic_id: str,
    epic_status: str = "open",
    epic_deps: list[str] | None = None,
    epic_title: str = "",
    tasks: list[dict] | None = None,
    last_validated_at: str | None = "2026-01-01T00:00:00Z",
    primary_repo: str | None = None,
    touched_repos: list[str] | None = None,
    closer_done_at: str | None = None,
    closer_acked_at: str | None = None,
    close_reason: str | None = None,
) -> dict:
    epic = {
        "id": epic_id,
        "status": epic_status,
        "title": epic_title,
        "depends_on_epics": epic_deps or [],
        "last_validated_at": last_validated_at,
        "primary_repo": primary_repo,
        "touched_repos": touched_repos,
    }
    if closer_done_at is not None:
        epic["closer_done_at"] = closer_done_at
    if closer_acked_at is not None:
        epic["closer_acked_at"] = closer_acked_at
    if close_reason is not None:
        epic["close_reason"] = close_reason
    return {"epic": epic, "tasks": tasks or []}


def _make_task(
    task_id: str,
    status: str = "todo",
    title: str = "",
    depends_on: list[str] | None = None,
    target_repo: str | None = None,
    worker_done_at: str | None = None,
    worker_acked_at: str | None = None,
) -> dict:
    row: dict = {
        "id": task_id,
        "status": status,
        "title": title,
        "depends_on": depends_on or [],
        "target_repo": target_repo,
    }
    if worker_done_at is not None:
        row["worker_done_at"] = worker_done_at
    if worker_acked_at is not None:
        row["worker_acked_at"] = worker_acked_at
    return row


PROJ = "/home/user/myproject"
PROJ2 = "/home/user/otherproject"


# ---------------------------------------------------------------------------
# derive_global_state — shape + happy paths
# ---------------------------------------------------------------------------


class TestDeriveGlobalStateEmptyPlans:
    def test_empty_plans_returns_all_five_keys(self):
        result = derive_global_state({})
        assert set(result.keys()) == {
            "in_progress",
            "workable",
            "close_ready",
            "ordered_items",
            "blocked_epics",
        }

    def test_empty_plans_all_empty(self):
        result = derive_global_state({})
        assert result["in_progress"] == []
        assert result["workable"] == []
        assert result["close_ready"] == []
        assert result["ordered_items"] == []
        assert result["blocked_epics"] == {}


class TestDeriveGlobalStateInProgress:
    def test_in_progress_task_surfaced(self):
        plans = {
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                tasks=[_make_task("fn-1-epic.1", status="in_progress")],
            )
        }
        result = derive_global_state(plans)
        assert len(result["in_progress"]) == 1
        row = result["in_progress"][0]
        assert row["proj"] == PROJ
        assert row["id"] == "fn-1-epic.1"
        assert row["kind"] == "task"
        assert row["status"] is None

    def test_in_progress_not_in_workable(self):
        plans = {
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                tasks=[_make_task("fn-1-epic.1", status="in_progress")],
            )
        }
        result = derive_global_state(plans)
        assert result["workable"] == []

    def test_in_progress_passes_through_repo_fields(self):
        plans = {
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                tasks=[
                    _make_task("fn-1-epic.1", status="in_progress", target_repo=PROJ2)
                ],
                primary_repo=PROJ,
            )
        }
        result = derive_global_state(plans)
        assert result["in_progress"][0]["target_repo"] == PROJ2
        assert result["in_progress"][0]["primary_repo"] == PROJ

    def test_no_close_rows_in_plan_state_model(self):
        """The plan-state-only deriver never emits 'close' rows."""
        plans = {
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                tasks=[_make_task("fn-1-epic.1", status="done")],
            )
        }
        result = derive_global_state(plans)
        assert all(row["kind"] != "close" for row in result["in_progress"])


# ---------------------------------------------------------------------------
# derive_global_state — workable
# ---------------------------------------------------------------------------


class TestDeriveGlobalStateWorkable:
    def test_todo_task_with_met_deps_is_workable(self):
        plans = {
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                tasks=[_make_task("fn-1-epic.1", status="todo", title="do thing")],
            )
        }
        result = derive_global_state(plans)
        assert len(result["workable"]) == 1
        item = result["workable"][0]
        assert item["proj"] == PROJ
        assert item["action_id"] == "fn-1-epic.1"
        assert item["label"] == "do thing"

    def test_workable_command_field_built_correctly(self):
        plans = {
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                tasks=[_make_task("fn-1-epic.1", status="todo")],
            )
        }
        result = derive_global_state(plans)
        expected_cmd = f'cd {shlex.quote(PROJ)} && claude "/plan:work fn-1-epic.1"'
        assert result["workable"][0]["command"] == expected_cmd
        assert result["workable"][0]["prompt"] == "/plan:work fn-1-epic.1"

    def test_todo_task_with_unmet_task_deps_not_workable(self):
        plans = {
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                tasks=[
                    _make_task("fn-1-epic.1", status="todo"),
                    _make_task(
                        "fn-1-epic.2", status="todo", depends_on=["fn-1-epic.1"]
                    ),
                ],
            )
        }
        result = derive_global_state(plans)
        # Only .1 is workable; .2 depends on .1 which is still todo.
        assert len(result["workable"]) == 1
        assert result["workable"][0]["action_id"] == "fn-1-epic.1"

    def test_todo_task_with_met_task_deps_is_workable(self):
        plans = {
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                tasks=[
                    _make_task("fn-1-epic.1", status="done"),
                    _make_task(
                        "fn-1-epic.2", status="todo", depends_on=["fn-1-epic.1"]
                    ),
                ],
            )
        }
        result = derive_global_state(plans)
        assert len(result["workable"]) == 1
        assert result["workable"][0]["action_id"] == "fn-1-epic.2"

    def test_pending_approval_task_dep_blocks_workable(self):
        """A dep task in pending_approval is not 'complete' → blocks downstream."""
        plans = {
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                tasks=[
                    _make_task(
                        "fn-1-epic.1",
                        status="done",
                        worker_done_at="2026-01-01T00:00:00Z",
                        # No worker_acked_at — pending_approval.
                    ),
                    _make_task(
                        "fn-1-epic.2", status="todo", depends_on=["fn-1-epic.1"]
                    ),
                ],
            )
        }
        result = derive_global_state(plans)
        workable_ids = [w["action_id"] for w in result["workable"]]
        assert "fn-1-epic.2" not in workable_ids

    def test_acked_task_dep_unblocks_workable(self):
        plans = {
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                tasks=[
                    _make_task(
                        "fn-1-epic.1",
                        status="done",
                        worker_done_at="2026-01-01T00:00:00Z",
                        worker_acked_at="2026-01-01T00:00:01Z",
                    ),
                    _make_task(
                        "fn-1-epic.2", status="todo", depends_on=["fn-1-epic.1"]
                    ),
                ],
            )
        }
        result = derive_global_state(plans)
        workable_ids = [w["action_id"] for w in result["workable"]]
        assert "fn-1-epic.2" in workable_ids


# ---------------------------------------------------------------------------
# derive_global_state — close_ready
# ---------------------------------------------------------------------------


class TestDeriveGlobalStateCloseReady:
    def test_epic_with_all_tasks_done_is_close_ready(self):
        plans = {
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                epic_title="my feature",
                tasks=[
                    _make_task("fn-1-epic.1", status="done"),
                    _make_task("fn-1-epic.2", status="done"),
                ],
            )
        }
        result = derive_global_state(plans)
        assert len(result["close_ready"]) == 1
        item = result["close_ready"][0]
        assert item["proj"] == PROJ
        assert item["action_id"] == "fn-1-epic"
        assert item["label"] == "close: my feature"

    def test_close_ready_command_built_correctly(self):
        plans = {
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                tasks=[_make_task("fn-1-epic.1", status="done")],
            )
        }
        result = derive_global_state(plans)
        expected_cmd = f'cd {shlex.quote(PROJ)} && claude "/plan:close fn-1-epic"'
        assert result["close_ready"][0]["command"] == expected_cmd
        assert result["close_ready"][0]["prompt"] == "/plan:close fn-1-epic"

    def test_close_ready_label_fallback_when_no_title(self):
        plans = {
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                epic_title="",
                tasks=[_make_task("fn-1-epic.1", status="done")],
            )
        }
        result = derive_global_state(plans)
        assert result["close_ready"][0]["label"] == "close epic"

    def test_epic_with_no_tasks_not_close_ready(self):
        plans = {f"{PROJ}::fn-1-epic": _make_bundle("fn-1-epic", tasks=[])}
        result = derive_global_state(plans)
        assert result["close_ready"] == []

    def test_epic_with_one_todo_task_not_close_ready(self):
        plans = {
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                tasks=[
                    _make_task("fn-1-epic.1", status="done"),
                    _make_task("fn-1-epic.2", status="todo"),
                ],
            )
        }
        result = derive_global_state(plans)
        assert result["close_ready"] == []

    def test_ordered_items_orders_workable_and_close_per_epic(self):
        plans = {
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                tasks=[_make_task("fn-1-epic.1", status="done")],
            ),
            f"{PROJ}::fn-2-epic": _make_bundle(
                "fn-2-epic",
                tasks=[_make_task("fn-2-epic.1", status="todo", title="next")],
            ),
        }
        result = derive_global_state(plans)
        # Epic 1 (close) then epic 2 (workable) — sorted by numeric prefix.
        assert [row["action_id"] for row in result["ordered_items"]] == [
            "fn-1-epic",
            "fn-2-epic.1",
        ]


# ---------------------------------------------------------------------------
# derive_global_state — blocked_epics (the critical dep/ready gate)
# ---------------------------------------------------------------------------


class TestDeriveGlobalStateBlockedEpics:
    def test_epic_with_unmet_dep_is_blocked(self):
        plans = {
            f"{PROJ}::fn-1-dep": _make_bundle("fn-1-dep", epic_status="open"),
            f"{PROJ}::fn-2-epic": _make_bundle(
                "fn-2-epic",
                epic_deps=["fn-1-dep"],
                tasks=[_make_task("fn-2-epic.1", status="todo")],
            ),
        }
        result = derive_global_state(plans)
        assert f"{PROJ}::fn-2-epic" in result["blocked_epics"]
        assert result["blocked_epics"][f"{PROJ}::fn-2-epic"] == {
            "blocked_pending": ["fn-1-dep"],
            "blocked_dangling": [],
        }
        # Blocked epic's tasks should not appear in workable.
        assert result["workable"] == []

    def test_epic_with_all_deps_done_not_blocked(self):
        plans = {
            f"{PROJ}::fn-1-dep": _make_bundle(
                "fn-1-dep",
                epic_status="done",
                tasks=[_make_task("fn-1-dep.1", status="done")],
            ),
            f"{PROJ}::fn-2-epic": _make_bundle(
                "fn-2-epic",
                epic_deps=["fn-1-dep"],
                tasks=[_make_task("fn-2-epic.1", status="todo")],
            ),
        }
        result = derive_global_state(plans)
        assert result["blocked_epics"] == {}
        assert len(result["workable"]) == 1

    def test_dep_epic_pending_approval_blocks_downstream(self):
        """fn-559: a closed-and-drained dep epic in pending_approval blocks
        downstream until acked.

        ``_dep_status`` classifies the dep as ``done`` (status==done) and does
        NOT add it to ``blocked_epics``.  The dep then passes to
        ``_dep_epics_runtime_complete`` which calls
        ``derive_epic_runtime_status`` — that returns ``pending_approval``
        (not ``complete``), so the runtime-complete gate rejects the dep and
        the downstream epic's tasks are hidden from workable (without
        appearing in blocked_epics).
        """
        plans = {
            f"{PROJ}::fn-1-dep": _make_bundle(
                "fn-1-dep",
                epic_status="done",
                closer_done_at="2026-01-01T00:00:00Z",
                # No closer_acked_at — surfaces as pending_approval.
                tasks=[_make_task("fn-1-dep.1", status="done")],
            ),
            f"{PROJ}::fn-2-epic": _make_bundle(
                "fn-2-epic",
                epic_deps=["fn-1-dep"],
                tasks=[_make_task("fn-2-epic.1", status="todo")],
            ),
        }
        result = derive_global_state(plans)
        workable_ids = [w["action_id"] for w in result["workable"]]
        assert "fn-2-epic.1" not in workable_ids
        # The dep epic itself is closed (status=done) so it is filtered out
        # of the open-bundles iteration that populates close_ready — it
        # appears in neither bucket while pending approval.
        close_ids = [c["action_id"] for c in result["close_ready"]]
        assert "fn-1-dep" not in close_ids
        # Also not in blocked_epics — _dep_status saw status==done.
        assert f"{PROJ}::fn-2-epic" not in result["blocked_epics"]

    def test_dep_epic_acked_unblocks_downstream(self):
        plans = {
            f"{PROJ}::fn-1-dep": _make_bundle(
                "fn-1-dep",
                epic_status="done",
                closer_done_at="2026-01-01T00:00:00Z",
                closer_acked_at="2026-01-01T00:00:01Z",
                tasks=[_make_task("fn-1-dep.1", status="done")],
            ),
            f"{PROJ}::fn-2-epic": _make_bundle(
                "fn-2-epic",
                epic_deps=["fn-1-dep"],
                tasks=[_make_task("fn-2-epic.1", status="todo")],
            ),
        }
        result = derive_global_state(plans)
        workable_ids = [w["action_id"] for w in result["workable"]]
        assert "fn-2-epic.1" in workable_ids

    def test_epic_with_multiple_unmet_deps_lists_all(self):
        plans = {
            f"{PROJ}::fn-1-a": _make_bundle("fn-1-a", epic_status="open"),
            f"{PROJ}::fn-2-b": _make_bundle("fn-2-b", epic_status="open"),
            f"{PROJ}::fn-3-epic": _make_bundle(
                "fn-3-epic",
                epic_deps=["fn-1-a", "fn-2-b"],
                tasks=[_make_task("fn-3-epic.1", status="todo")],
            ),
        }
        result = derive_global_state(plans)
        blocked = result["blocked_epics"][f"{PROJ}::fn-3-epic"]
        assert blocked["blocked_pending"] == ["fn-1-a", "fn-2-b"]
        assert blocked["blocked_dangling"] == []

    def test_blocked_epics_ordered_by_key_asc(self):
        plans = {
            f"{PROJ}::fn-5-dep": _make_bundle("fn-5-dep", epic_status="open"),
            f"{PROJ}::fn-1-dep": _make_bundle("fn-1-dep", epic_status="open"),
            f"{PROJ}::fn-3-epic": _make_bundle(
                "fn-3-epic", epic_deps=["fn-5-dep"], tasks=[]
            ),
            f"{PROJ}::fn-2-epic": _make_bundle(
                "fn-2-epic", epic_deps=["fn-1-dep"], tasks=[]
            ),
        }
        result = derive_global_state(plans)
        keys = list(result["blocked_epics"].keys())
        assert keys == sorted(keys)

    def test_dangling_dep_id_surfaces_as_blocked_dangling(self):
        """An epic_deps entry that resolves nowhere surfaces in blocked_dangling."""
        plans = {
            f"{PROJ}::fn-2-epic": _make_bundle(
                "fn-2-epic",
                epic_deps=["fn-99-deleted"],
                tasks=[_make_task("fn-2-epic.1", status="todo")],
            ),
        }
        result = derive_global_state(plans)
        assert f"{PROJ}::fn-2-epic" in result["blocked_epics"]
        assert result["blocked_epics"][f"{PROJ}::fn-2-epic"] == {
            "blocked_pending": [],
            "blocked_dangling": ["fn-99-deleted"],
        }
        assert result["workable"] == []

    def test_mixed_pending_and_dangling_deps_split_correctly(self):
        plans = {
            f"{PROJ}::fn-1-pending": _make_bundle("fn-1-pending", epic_status="open"),
            f"{PROJ}::fn-2-epic": _make_bundle(
                "fn-2-epic",
                epic_deps=["fn-1-pending", "fn-99-dangling"],
                tasks=[_make_task("fn-2-epic.1", status="todo")],
            ),
        }
        result = derive_global_state(plans)
        assert result["blocked_epics"][f"{PROJ}::fn-2-epic"] == {
            "blocked_pending": ["fn-1-pending"],
            "blocked_dangling": ["fn-99-dangling"],
        }


# ---------------------------------------------------------------------------
# derive_global_state — cross-project deps (fn-600)
# ---------------------------------------------------------------------------


class TestDeriveGlobalStateCrossProjectDeps:
    def test_cross_project_dep_resolved_done_satisfies_gate(self):
        plans = {
            f"{PROJ2}::fn-1-dep": _make_bundle(
                "fn-1-dep",
                epic_status="done",
                tasks=[_make_task("fn-1-dep.1", status="done")],
            ),
            f"{PROJ}::fn-2-epic": _make_bundle(
                "fn-2-epic",
                epic_deps=["fn-1-dep"],
                tasks=[_make_task("fn-2-epic.1", status="todo")],
            ),
        }
        result = derive_global_state(plans)
        assert result["blocked_epics"] == {}
        assert len(result["workable"]) == 1
        assert result["workable"][0]["proj"] == PROJ
        assert result["workable"][0]["action_id"] == "fn-2-epic.1"

    def test_cross_project_dep_resolved_pending_blocks_as_pending(self):
        plans = {
            f"{PROJ2}::fn-1-dep": _make_bundle("fn-1-dep", epic_status="open"),
            f"{PROJ}::fn-2-epic": _make_bundle(
                "fn-2-epic",
                epic_deps=["fn-1-dep"],
                tasks=[_make_task("fn-2-epic.1", status="todo")],
            ),
        }
        result = derive_global_state(plans)
        assert f"{PROJ}::fn-2-epic" in result["blocked_epics"]
        assert result["blocked_epics"][f"{PROJ}::fn-2-epic"] == {
            "blocked_pending": ["fn-1-dep"],
            "blocked_dangling": [],
        }
        assert result["workable"] == []

    def test_cross_project_dep_dangling_surfaces_as_blocked_dangling(self):
        plans = {
            f"{PROJ}::fn-2-epic": _make_bundle(
                "fn-2-epic",
                epic_deps=["fn-99-deleted"],
                tasks=[_make_task("fn-2-epic.1", status="todo")],
            ),
        }
        result = derive_global_state(plans)
        assert f"{PROJ}::fn-2-epic" in result["blocked_epics"]
        assert result["blocked_epics"][f"{PROJ}::fn-2-epic"] == {
            "blocked_pending": [],
            "blocked_dangling": ["fn-99-deleted"],
        }
        assert result["workable"] == []

    def test_cross_project_hard_gate_unhides_when_dep_completes(self):
        # Phase 1: cross-project dep is OPEN.
        plans_pending = {
            f"{PROJ2}::fn-1-dep": _make_bundle(
                "fn-1-dep",
                epic_status="open",
                tasks=[_make_task("fn-1-dep.1", status="in_progress")],
            ),
            f"{PROJ}::fn-2-epic": _make_bundle(
                "fn-2-epic",
                epic_deps=["fn-1-dep"],
                tasks=[_make_task("fn-2-epic.1", status="todo")],
            ),
        }
        result_pending = derive_global_state(plans_pending)
        assert f"{PROJ}::fn-2-epic" in result_pending["blocked_epics"]
        assert result_pending["workable"] == []

        # Phase 2: cross-project dep transitions to DONE.
        plans_done = {
            f"{PROJ2}::fn-1-dep": _make_bundle(
                "fn-1-dep",
                epic_status="done",
                tasks=[_make_task("fn-1-dep.1", status="done")],
            ),
            f"{PROJ}::fn-2-epic": _make_bundle(
                "fn-2-epic",
                epic_deps=["fn-1-dep"],
                tasks=[_make_task("fn-2-epic.1", status="todo")],
            ),
        }
        result_done = derive_global_state(plans_done)
        assert result_done["blocked_epics"] == {}
        assert len(result_done["workable"]) == 1
        assert result_done["workable"][0]["proj"] == PROJ


# ---------------------------------------------------------------------------
# derive_global_state — multi-project no-leak
# ---------------------------------------------------------------------------


class TestDeriveGlobalStateMultiProject:
    def test_same_epic_id_in_two_projects_no_cross_project_leak(self):
        """fn-1-epic in PROJ is done; fn-1-epic in PROJ2 is open with a todo task.
        The task in PROJ2 should be workable."""
        plans = {
            f"{PROJ}::fn-1-epic": _make_bundle("fn-1-epic", epic_status="done"),
            f"{PROJ2}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                tasks=[_make_task("fn-1-epic.1", status="todo")],
            ),
        }
        result = derive_global_state(plans)
        assert len(result["workable"]) == 1
        assert result["workable"][0]["proj"] == PROJ2

    def test_closed_epic_not_in_any_output(self):
        plans = {
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                epic_status="done",
                tasks=[_make_task("fn-1-epic.1", status="todo")],
            )
        }
        result = derive_global_state(plans)
        assert result["in_progress"] == []
        assert result["workable"] == []
        assert result["close_ready"] == []
        assert result["blocked_epics"] == {}


# ---------------------------------------------------------------------------
# derive_global_state — unvalidated epics hidden
# ---------------------------------------------------------------------------


class TestDeriveGlobalStateUnvalidatedEpics:
    """Epics with last_validated_at=None must not appear in any output bucket."""

    def test_unvalidated_epic_hidden_from_workable(self):
        plans = {
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                tasks=[_make_task("fn-1-epic.1", status="todo")],
                last_validated_at=None,
            )
        }
        result = derive_global_state(plans)
        assert result["workable"] == []

    def test_unvalidated_epic_hidden_from_close_ready(self):
        plans = {
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                tasks=[_make_task("fn-1-epic.1", status="done")],
                last_validated_at=None,
            )
        }
        result = derive_global_state(plans)
        assert result["close_ready"] == []

    def test_unvalidated_epic_hidden_from_blocked_epics(self):
        plans = {
            f"{PROJ}::fn-1-dep": _make_bundle("fn-1-dep", epic_status="open"),
            f"{PROJ}::fn-2-epic": _make_bundle(
                "fn-2-epic",
                epic_deps=["fn-1-dep"],
                tasks=[_make_task("fn-2-epic.1", status="todo")],
                last_validated_at=None,
            ),
        }
        result = derive_global_state(plans)
        assert result["blocked_epics"] == {}

    def test_validated_epic_appears_in_workable(self):
        plans = {
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                tasks=[_make_task("fn-1-epic.1", status="todo", title="do thing")],
                last_validated_at="2026-01-01T00:00:00Z",
            )
        }
        result = derive_global_state(plans)
        assert len(result["workable"]) == 1

    def test_mixed_validated_and_unvalidated_only_validated_surfaces(self):
        plans = {
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                tasks=[_make_task("fn-1-epic.1", status="todo")],
                last_validated_at="2026-01-01T00:00:00Z",
            ),
            f"{PROJ}::fn-2-epic": _make_bundle(
                "fn-2-epic",
                tasks=[_make_task("fn-2-epic.1", status="todo")],
                last_validated_at=None,
            ),
        }
        result = derive_global_state(plans)
        assert len(result["workable"]) == 1
        assert result["workable"][0]["action_id"] == "fn-1-epic.1"


# ---------------------------------------------------------------------------
# derive_global_state — malformed keys tolerated
# ---------------------------------------------------------------------------


class TestDeriveGlobalStateMalformedKeys:
    def test_malformed_key_no_separator_skipped(self):
        plans = {
            "no-separator-here": _make_bundle("fn-1-epic"),
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                tasks=[_make_task("fn-1-epic.1", status="todo")],
            ),
        }
        result = derive_global_state(plans)
        assert len(result["workable"]) == 1

    def test_non_string_key_skipped(self):
        plans = {
            42: _make_bundle("fn-1-epic"),  # type: ignore[dict-item]
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                tasks=[_make_task("fn-1-epic.1", status="todo")],
            ),
        }
        result = derive_global_state(plans)
        assert len(result["workable"]) == 1


# ---------------------------------------------------------------------------
# Multi-repo passthrough (fn-364)
# ---------------------------------------------------------------------------


class TestMultiRepoFieldsPassthrough:
    """_compute_workable_tasks passes target_repo, primary_repo, touched_repos through."""

    def test_workable_row_carries_target_repo(self):
        from planctl.global_state import _compute_workable_tasks

        bundle = _make_bundle(
            "fn-1-epic",
            tasks=[_make_task("fn-1-epic.1", status="todo", target_repo=PROJ2)],
            primary_repo=PROJ,
            touched_repos=[PROJ, PROJ2],
        )
        plans = {f"{PROJ}::fn-1-epic": bundle}
        workable, _, _, _ = _compute_workable_tasks(plans)
        assert len(workable) == 1
        assert workable[0]["target_repo"] == PROJ2
        assert workable[0]["primary_repo"] == PROJ
        assert workable[0]["touched_repos"] == [PROJ, PROJ2]

    def test_workable_row_target_repo_none_when_absent(self):
        from planctl.global_state import _compute_workable_tasks

        plans = {
            f"{PROJ}::fn-1-epic": _make_bundle(
                "fn-1-epic",
                tasks=[_make_task("fn-1-epic.1", status="todo")],
            )
        }
        workable, _, _, _ = _compute_workable_tasks(plans)
        assert len(workable) == 1
        assert workable[0]["target_repo"] is None
        assert workable[0]["primary_repo"] is None
        assert workable[0]["touched_repos"] is None

    def test_close_ready_row_carries_touched_repos(self):
        from planctl.global_state import _compute_workable_tasks

        bundle = _make_bundle(
            "fn-1-epic",
            tasks=[_make_task("fn-1-epic.1", status="done")],
            primary_repo=PROJ,
            touched_repos=[PROJ, PROJ2],
        )
        plans = {f"{PROJ}::fn-1-epic": bundle}
        _, close_ready, _, _ = _compute_workable_tasks(plans)
        assert len(close_ready) == 1
        assert close_ready[0]["primary_repo"] == PROJ
        assert close_ready[0]["touched_repos"] == [PROJ, PROJ2]

    def test_workable_cd_uses_expected_worker_cwd(self):
        """The `cd <path>` in the workable command quotes expected_worker_cwd
        (task.target_repo wins over epic.primary_repo wins over proj)."""
        from planctl.global_state import _compute_workable_tasks

        bundle = _make_bundle(
            "fn-1-epic",
            tasks=[_make_task("fn-1-epic.1", status="todo", target_repo=PROJ2)],
            primary_repo=PROJ,
        )
        plans = {f"{PROJ}::fn-1-epic": bundle}
        workable, _, _, _ = _compute_workable_tasks(plans)
        assert workable[0]["command"] == (
            f'cd {shlex.quote(PROJ2)} && claude "/plan:work fn-1-epic.1"'
        )

    def test_close_ready_cd_uses_expected_closer_cwd(self):
        """The `cd <path>` in close_ready quotes epic.primary_repo (falls to proj)."""
        from planctl.global_state import _compute_workable_tasks

        bundle = _make_bundle(
            "fn-1-epic",
            tasks=[_make_task("fn-1-epic.1", status="done")],
            primary_repo=PROJ2,
        )
        plans = {f"{PROJ}::fn-1-epic": bundle}
        _, close_ready, _, _ = _compute_workable_tasks(plans)
        assert close_ready[0]["command"] == (
            f'cd {shlex.quote(PROJ2)} && claude "/plan:close fn-1-epic"'
        )


# ---------------------------------------------------------------------------
# apply_plans_event
# ---------------------------------------------------------------------------


class TestApplyPlansEvent:
    def test_plans_updated_writes_key_returns_true(self):
        plans: dict = {}
        env = {
            "type": "event",
            "namespace": "plans",
            "event": "plans_updated",
            "key": f"{PROJ}::fn-1-epic",
            "row": {"epic": {"id": "fn-1-epic", "status": "open"}, "tasks": []},
        }
        changed = apply_plans_event(plans, env)
        assert changed is True
        assert f"{PROJ}::fn-1-epic" in plans

    def test_plans_removed_pops_key_returns_true(self):
        key = f"{PROJ}::fn-1-epic"
        plans = {key: {"epic": {"id": "fn-1-epic"}, "tasks": []}}
        env = {
            "type": "event",
            "namespace": "plans",
            "event": "plans_removed",
            "key": key,
        }
        changed = apply_plans_event(plans, env)
        assert changed is True
        assert key not in plans

    def test_non_event_type_returns_false(self):
        plans: dict = {}
        env = {"type": "boot_status", "namespace": "plans", "key": "x"}
        changed = apply_plans_event(plans, env)
        assert changed is False
        assert plans == {}

    def test_non_plans_namespace_returns_false(self):
        plans: dict = {}
        env = {
            "type": "event",
            "namespace": "other",
            "event": "plans_updated",
            "key": "x",
            "row": {},
        }
        changed = apply_plans_event(plans, env)
        assert changed is False

    def test_missing_key_field_returns_false(self):
        plans: dict = {}
        env = {
            "type": "event",
            "namespace": "plans",
            "event": "plans_updated",
            "row": {},
        }
        changed = apply_plans_event(plans, env)
        assert changed is False

    def test_malformed_row_not_dict_returns_false(self):
        plans: dict = {}
        env = {
            "type": "event",
            "namespace": "plans",
            "event": "plans_updated",
            "key": f"{PROJ}::fn-1-epic",
            "row": "not-a-dict",
        }
        changed = apply_plans_event(plans, env)
        assert changed is False
        assert plans == {}

    def test_plans_updated_mutates_in_place(self):
        key = f"{PROJ}::fn-1-epic"
        plans = {key: {"epic": {"id": "fn-1-epic", "status": "open"}, "tasks": []}}
        new_row = {
            "epic": {"id": "fn-1-epic", "status": "open"},
            "tasks": [{"id": "fn-1-epic.1", "status": "done"}],
        }
        env = {
            "type": "event",
            "namespace": "plans",
            "event": "plans_updated",
            "key": key,
            "row": new_row,
        }
        apply_plans_event(plans, env)
        assert plans[key] == new_row

    def test_plans_removed_missing_key_still_returns_true(self):
        plans: dict = {}
        env = {
            "type": "event",
            "namespace": "plans",
            "event": "plans_removed",
            "key": "nonexistent::key",
        }
        changed = apply_plans_event(plans, env)
        assert changed is True


class TestApplyPlansEventNoOp:
    """apply_plans_event must return False and leave plans untouched for
    non-mutating envelope shapes."""

    def _plans_with_entry(self) -> dict:
        return {
            f"{PROJ}::fn-1-epic": {
                "epic": {"id": "fn-1-epic", "status": "open"},
                "tasks": [{"id": "fn-1-epic.1", "status": "todo"}],
            }
        }

    def test_boot_status_returns_false_leaves_plans_untouched(self):
        plans = self._plans_with_entry()
        before = copy.deepcopy(plans)
        env = {"type": "boot_status", "ready": ["plans"], "pending": []}
        changed = apply_plans_event(plans, env)
        assert changed is False
        assert plans == before
        assert plans is not before

    def test_wrong_namespace_returns_false_leaves_plans_untouched(self):
        plans = self._plans_with_entry()
        before = copy.deepcopy(plans)
        env = {
            "type": "event",
            "namespace": "not-plans",
            "event": "plans_updated",
            "key": f"{PROJ}::fn-1-epic",
            "row": {"epic": {"id": "fn-1-epic", "status": "done"}, "tasks": []},
        }
        changed = apply_plans_event(plans, env)
        assert changed is False
        assert plans == before

    def test_snapshot_full_replaces_plans(self):
        plans = self._plans_with_entry()
        new_key = "new-proj::fn-99-epic"
        new_row = {"epic": {"id": "fn-99-epic"}, "tasks": []}
        env = {"type": "snapshot", "state": {"plans": {new_key: new_row}}}
        changed = apply_plans_event(plans, env)
        assert changed is True
        assert f"{PROJ}::fn-1-epic" not in plans
        assert plans[new_key] == new_row

    def test_snapshot_with_no_change_returns_false(self):
        key = f"{PROJ}::fn-1-epic"
        row = {"epic": {"id": "fn-1-epic", "status": "open"}, "tasks": []}
        plans = {key: row}
        env = {"type": "snapshot", "state": {"plans": {key: row}}}
        changed = apply_plans_event(plans, env)
        assert changed is False
        assert plans == {key: row}

    def test_snapshot_empty_replacing_empty_returns_false(self):
        plans: dict = {}
        env = {"type": "snapshot", "state": {"plans": {}}}
        changed = apply_plans_event(plans, env)
        assert changed is False
        assert plans == {}

    def test_snapshot_missing_state_key_is_noop(self):
        plans = self._plans_with_entry()
        before = copy.deepcopy(plans)
        env = {"type": "snapshot"}
        changed = apply_plans_event(plans, env)
        assert changed is False
        assert plans == before

    def test_snapshot_missing_state_plans_key_is_noop(self):
        plans = self._plans_with_entry()
        before = copy.deepcopy(plans)
        env = {"type": "snapshot", "state": {"arcs": {}, "jobs": {}}}
        changed = apply_plans_event(plans, env)
        assert changed is False
        assert plans == before

    def test_snapshot_unknown_namespaces_tolerated(self):
        plans: dict = {}
        env = {
            "type": "snapshot",
            "state": {
                "plans": {f"{PROJ}::fn-1-epic": {"epic": {}, "tasks": []}},
                "keeper": {"some::key": {}},
                "commits": {"sha1": {}},
                "arcs": {},
                "projects": {},
                "planctl_invocations": [],
            },
        }
        changed = apply_plans_event(plans, env)
        assert changed is True
        assert f"{PROJ}::fn-1-epic" in plans
