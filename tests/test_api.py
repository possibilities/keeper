"""Tests for planctl.api: load_epic and load_tasks_for_epic raising contract.

Also covers the fn-488 task .8 cross-CLI re-export surface — the sibling
External CLIs must reach these helpers via ``planctl.api`` per the
cli-boundaries lint, so the public re-exports get a smoke test apiece.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from planctl import api as papi
from planctl.api import load_epic, load_tasks_for_epic
from planctl.project import ProjectContext
from planctl.store import atomic_write_json


def _make_project(tmp_path: Path) -> tuple[ProjectContext, Path]:
    """Build a minimal .planctl/ tree and return (ProjectContext, planctl_dir)."""
    planctl_dir = tmp_path / ".planctl"
    (planctl_dir / "epics").mkdir(parents=True)
    (planctl_dir / "tasks").mkdir(parents=True)
    (planctl_dir / "state" / "tasks").mkdir(parents=True)
    ctx = ProjectContext(
        name=tmp_path.name,
        data_dir=planctl_dir,
        state_dir=planctl_dir / "state",
        project_path=tmp_path,
    )
    return ctx, planctl_dir


# ---------------------------------------------------------------------------
# load_epic
# ---------------------------------------------------------------------------


class TestLoadEpic:
    def test_returns_normalized_dict_on_clean_file(self, tmp_path: Path) -> None:
        ctx, planctl_dir = _make_project(tmp_path)
        epic_data = {
            "id": "fn-1-slug",
            "title": "My Epic",
            "status": "open",
            "updated_at": "2026-01-01T00:00:00Z",
        }
        atomic_write_json(planctl_dir / "epics" / "fn-1-slug.json", epic_data)

        result = load_epic(ctx, "fn-1-slug")

        assert isinstance(result, dict)
        assert result["id"] == "fn-1-slug"
        assert result["title"] == "My Epic"
        # normalize_epic fills these defaults
        assert "plan_review_status" in result

    def test_raises_file_not_found_when_absent(self, tmp_path: Path) -> None:
        ctx, _ = _make_project(tmp_path)

        with pytest.raises(FileNotFoundError):
            load_epic(ctx, "fn-missing")

    def test_raises_json_decode_error_on_half_write(self, tmp_path: Path) -> None:
        ctx, planctl_dir = _make_project(tmp_path)
        half_path = planctl_dir / "epics" / "fn-half.json"
        half_path.write_text('{"id": "fn-half", "stat')

        with pytest.raises(json.JSONDecodeError):
            load_epic(ctx, "fn-half")


# ---------------------------------------------------------------------------
# load_tasks_for_epic
# ---------------------------------------------------------------------------


class TestLoadTasksForEpic:
    def test_returns_empty_list_when_tasks_dir_absent(self, tmp_path: Path) -> None:
        planctl_dir = tmp_path / ".planctl"
        (planctl_dir / "epics").mkdir(parents=True)
        # No tasks/ dir
        (planctl_dir / "state" / "tasks").mkdir(parents=True)
        ctx = ProjectContext(
            name=tmp_path.name,
            data_dir=planctl_dir,
            state_dir=planctl_dir / "state",
            project_path=tmp_path,
        )

        result = load_tasks_for_epic(ctx, "fn-1-slug")

        assert result == []

    def test_returns_merged_list_on_clean_dir(self, tmp_path: Path) -> None:
        ctx, planctl_dir = _make_project(tmp_path)
        task1 = {"id": "fn-2-slug.1", "title": "Task One", "epic": "fn-2-slug"}
        task2 = {"id": "fn-2-slug.2", "title": "Task Two", "epic": "fn-2-slug"}
        atomic_write_json(planctl_dir / "tasks" / "fn-2-slug.1.json", task1)
        atomic_write_json(planctl_dir / "tasks" / "fn-2-slug.2.json", task2)
        # runtime state for task1: in_progress
        runtime1 = {"status": "in_progress", "updated_at": "2026-01-01T00:00:00Z"}
        atomic_write_json(
            planctl_dir / "state" / "tasks" / "fn-2-slug.1.state.json", runtime1
        )

        result = load_tasks_for_epic(ctx, "fn-2-slug")

        assert len(result) == 2
        ids = {t["id"] for t in result}
        assert ids == {"fn-2-slug.1", "fn-2-slug.2"}
        by_id = {t["id"]: t for t in result}
        assert by_id["fn-2-slug.1"]["status"] == "in_progress"
        # task2 has no runtime state → defaults to todo
        assert by_id["fn-2-slug.2"]["status"] == "todo"

    def test_raises_json_decode_error_when_one_file_half_written(
        self, tmp_path: Path
    ) -> None:
        ctx, planctl_dir = _make_project(tmp_path)
        task1 = {"id": "fn-3-slug.1", "title": "Task Good", "epic": "fn-3-slug"}
        atomic_write_json(planctl_dir / "tasks" / "fn-3-slug.1.json", task1)
        half_path = planctl_dir / "tasks" / "fn-3-slug.2.json"
        half_path.write_text('{"id": "fn-3-slug.2", "titl')

        with pytest.raises(json.JSONDecodeError):
            load_tasks_for_epic(ctx, "fn-3-slug")


# ---------------------------------------------------------------------------
# fn-488 task .8: cross-CLI re-export surface
# ---------------------------------------------------------------------------


class TestCrossCliReExports:
    """The cli-boundaries lint forces sibling CLIs to import via planctl.api.

    These re-exports back that contract: anything routed through ``planctl.api``
    on the consumer side must resolve to the canonical implementation in its
    owning submodule. Smoke-test identity to catch accidental shadowing.
    """

    def test_acks_submodule_round_trips(self, tmp_path: Path) -> None:
        # Real acks.db round trip via the re-exported module.
        papi.acks.save_epic_ack(
            "fn-77-slug", "2026-05-16T00:00:00Z", repo_root=tmp_path
        )
        result = papi.acks.all_epic_acks(repo_root=tmp_path)
        assert result == {"fn-77-slug": "2026-05-16T00:00:00Z"}
        assert (
            papi.acks.get_epic_ack("fn-77-slug", repo_root=tmp_path)
            == "2026-05-16T00:00:00Z"
        )

    def test_id_regex_is_canonical_re(self) -> None:
        from planctl.ids import ID_REGEX as canonical

        assert papi.ID_REGEX is canonical
        # Spot-check matching against an epic id and a task id.
        assert papi.ID_REGEX.match("fn-1-slug") is not None
        assert papi.ID_REGEX.match("fn-1-slug.3") is not None

    def test_predicates_round_trip(self) -> None:
        assert papi.is_epic_id("fn-9-slug") is True
        assert papi.is_task_id("fn-9-slug.1") is True
        assert papi.is_job_id("11111111-2222-3333-4444-555555555555") is True
        assert papi.is_job_id("fn-9-slug") is False

    def test_expected_cwd_helpers_match_runtime_status(self) -> None:
        # The façade should produce the same values the canonical helpers do.
        from planctl.runtime_status import (
            _expected_closer_cwd,
            _expected_worker_cwd,
        )

        epic = {"primary_repo": "/p"}
        task = {"target_repo": "/t"}
        assert papi.expected_closer_cwd(epic, "/proj") == _expected_closer_cwd(
            epic, "/proj"
        )
        assert papi.expected_worker_cwd(task, epic, "/proj") == _expected_worker_cwd(
            task, epic, "/proj"
        )
