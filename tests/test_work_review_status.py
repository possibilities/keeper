"""Tests for work_review_status field on task + epic, and the set-work-review-status commands.

fn-614 task .3: session-id env renamed JOBCTL_SESSION_ID → PLANCTL_SESSION_ID.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from click.testing import CliRunner
from planctl.cli import cli

from .conftest import parse_cli_output


@pytest.fixture
def project(tmp_path, monkeypatch):
    """Create a throwaway planctl project and chdir to it.

    fn-589 task .1 (item 2): scaffold + refine-apply now run filesystem-repo
    integrity at mint time, so the project root must be a real git repo for
    refine-apply (via _create_task) to succeed.
    """
    import subprocess

    monkeypatch.setenv("PLANCTL_SESSION_ID", "test-session-fixture")
    monkeypatch.chdir(tmp_path)
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    runner = CliRunner()
    result = runner.invoke(cli, ["init"])
    assert result.exit_code == 0, result.output
    return tmp_path


def _invoke(args: list[str]):
    return CliRunner().invoke(cli, args)


def _create_epic(title: str = "Test Epic") -> str:
    """Create an epic and return its ID."""
    result = _invoke(["epic", "create", "--title", title])
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    return payload["epic"]["id"]


def _create_task(epic_id: str, title: str = "Test Task") -> str:
    """Add a task to an epic via `refine-apply`, return its ID (fn-565)."""
    from pathlib import Path

    from .conftest import add_task

    return add_task(Path.cwd(), epic_id, title=title)


# --- Field defaults: epic ---


def test_fresh_epic_has_unknown_work_review_status(project: Path):
    epic_id = _create_epic()
    result = _invoke(["show", epic_id])
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["epic"]["work_review_status"] == "unknown"
    assert payload["epic"]["work_reviewed_at"] is None


def test_normalize_epic_defaults_on_old_schema(project: Path):
    """Pre-existing epics without the fields still load via normalize_epic."""
    epic_id = _create_epic()
    epic_path = project / ".planctl" / "epics" / f"{epic_id}.json"
    epic_def = json.loads(epic_path.read_text())
    epic_def.pop("work_review_status", None)
    epic_def.pop("work_reviewed_at", None)
    epic_path.write_text(json.dumps(epic_def, indent=2) + "\n")

    result = _invoke(["show", epic_id])
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["epic"]["work_review_status"] == "unknown"
    assert payload["epic"]["work_reviewed_at"] is None


# --- Field defaults: task ---


def test_fresh_task_has_unknown_work_review_status(project: Path):
    epic_id = _create_epic()
    task_id = _create_task(epic_id)
    result = _invoke(["show", task_id])
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["task"]["work_review_status"] == "unknown"
    assert payload["task"]["work_reviewed_at"] is None


def test_normalize_task_defaults_on_old_schema(project: Path):
    """Pre-existing tasks without the fields still load via normalize_task."""
    epic_id = _create_epic()
    task_id = _create_task(epic_id)
    task_path = project / ".planctl" / "tasks" / f"{task_id}.json"
    task_def = json.loads(task_path.read_text())
    task_def.pop("work_review_status", None)
    task_def.pop("work_reviewed_at", None)
    task_path.write_text(json.dumps(task_def, indent=2) + "\n")

    result = _invoke(["show", task_id])
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["task"]["work_review_status"] == "unknown"
    assert payload["task"]["work_reviewed_at"] is None


# --- epic set-work-review-status ---


def test_epic_set_work_review_status_ship(project: Path):
    epic_id = _create_epic()
    result = _invoke(["epic", "set-work-review-status", epic_id, "--status", "ship"])
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["success"] is True
    assert payload["work_review_status"] == "ship"
    assert payload["work_reviewed_at"] is not None


def test_epic_set_work_review_status_ship_persists(project: Path):
    epic_id = _create_epic()
    _invoke(["epic", "set-work-review-status", epic_id, "--status", "ship"])

    result = _invoke(["show", epic_id])
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["epic"]["work_review_status"] == "ship"
    assert payload["epic"]["work_reviewed_at"] is not None


def test_epic_set_work_review_status_needs_work(project: Path):
    epic_id = _create_epic()
    result = _invoke(
        ["epic", "set-work-review-status", epic_id, "--status", "needs_work"]
    )
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["success"] is True
    assert payload["work_review_status"] == "needs_work"
    assert payload["work_reviewed_at"] is not None


def test_epic_set_work_review_status_unknown(project: Path):
    """Can reset back to unknown."""
    epic_id = _create_epic()
    _invoke(["epic", "set-work-review-status", epic_id, "--status", "ship"])
    result = _invoke(["epic", "set-work-review-status", epic_id, "--status", "unknown"])
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["work_review_status"] == "unknown"


def test_epic_set_work_review_status_updates_reviewed_at_on_change(project: Path):
    """Changing status updates work_reviewed_at."""
    epic_id = _create_epic()
    r1 = _invoke(["epic", "set-work-review-status", epic_id, "--status", "ship"])
    t1 = json.loads(r1.output)["work_reviewed_at"]

    r2 = _invoke(["epic", "set-work-review-status", epic_id, "--status", "needs_work"])
    t2 = json.loads(r2.output)["work_reviewed_at"]

    assert t1 is not None
    assert t2 is not None
    assert t2 >= t1


def test_epic_set_work_review_status_invalid_status_exits_nonzero(project: Path):
    epic_id = _create_epic()
    result = _invoke(["epic", "set-work-review-status", epic_id, "--status", "bogus"])
    assert result.exit_code != 0


def test_epic_set_work_review_status_missing_epic_exits_nonzero(project: Path):
    result = _invoke(
        [
            "epic",
            "set-work-review-status",
            "fn-99-nonexistent",
            "--status",
            "ship",
        ]
    )
    assert result.exit_code != 0


# --- task set-work-review-status ---


def test_task_set_work_review_status_ship(project: Path):
    epic_id = _create_epic()
    task_id = _create_task(epic_id)
    result = _invoke(["task", "set-work-review-status", task_id, "--status", "ship"])
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["success"] is True
    assert payload["work_review_status"] == "ship"
    assert payload["work_reviewed_at"] is not None


def test_task_set_work_review_status_ship_persists(project: Path):
    epic_id = _create_epic()
    task_id = _create_task(epic_id)
    _invoke(["task", "set-work-review-status", task_id, "--status", "ship"])

    result = _invoke(["show", task_id])
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["task"]["work_review_status"] == "ship"
    assert payload["task"]["work_reviewed_at"] is not None


def test_task_set_work_review_status_needs_work(project: Path):
    epic_id = _create_epic()
    task_id = _create_task(epic_id)
    result = _invoke(
        ["task", "set-work-review-status", task_id, "--status", "needs_work"]
    )
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["success"] is True
    assert payload["work_review_status"] == "needs_work"
    assert payload["work_reviewed_at"] is not None


def test_task_set_work_review_status_unknown(project: Path):
    """Can reset back to unknown."""
    epic_id = _create_epic()
    task_id = _create_task(epic_id)
    _invoke(["task", "set-work-review-status", task_id, "--status", "ship"])
    result = _invoke(["task", "set-work-review-status", task_id, "--status", "unknown"])
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["work_review_status"] == "unknown"


def test_task_set_work_review_status_updates_reviewed_at_on_change(project: Path):
    """Changing status updates work_reviewed_at."""
    epic_id = _create_epic()
    task_id = _create_task(epic_id)
    r1 = _invoke(["task", "set-work-review-status", task_id, "--status", "ship"])
    t1 = json.loads(r1.output)["work_reviewed_at"]

    r2 = _invoke(["task", "set-work-review-status", task_id, "--status", "needs_work"])
    t2 = json.loads(r2.output)["work_reviewed_at"]

    assert t1 is not None
    assert t2 is not None
    assert t2 >= t1


def test_task_set_work_review_status_invalid_status_exits_nonzero(project: Path):
    epic_id = _create_epic()
    task_id = _create_task(epic_id)
    result = _invoke(["task", "set-work-review-status", task_id, "--status", "bogus"])
    assert result.exit_code != 0


def test_task_set_work_review_status_missing_task_exits_nonzero(project: Path):
    result = _invoke(
        [
            "task",
            "set-work-review-status",
            "fn-99-nonexistent.1",
            "--status",
            "ship",
        ]
    )
    assert result.exit_code != 0


# --- planctl show text output: epic ---


def test_show_epic_text_surfaces_work_review_status(project: Path):
    epic_id = _create_epic()
    result = _invoke(["--format", "human", "show", epic_id])
    assert result.exit_code == 0, result.output
    assert "Work review: unknown" in result.output


def test_show_epic_text_surfaces_work_reviewed_at_when_set(project: Path):
    epic_id = _create_epic()
    _invoke(["epic", "set-work-review-status", epic_id, "--status", "ship"])
    result = _invoke(["--format", "human", "show", epic_id])
    assert result.exit_code == 0, result.output
    assert "Work review: ship" in result.output
    assert "Work reviewed at:" in result.output


# --- planctl show text output: task ---


def test_show_task_text_surfaces_work_review_status(project: Path):
    epic_id = _create_epic()
    task_id = _create_task(epic_id)
    result = _invoke(["--format", "human", "show", task_id])
    assert result.exit_code == 0, result.output
    assert "Work review: unknown" in result.output


def test_show_task_text_surfaces_work_reviewed_at_when_set(project: Path):
    epic_id = _create_epic()
    task_id = _create_task(epic_id)
    _invoke(["task", "set-work-review-status", task_id, "--status", "ship"])
    result = _invoke(["--format", "human", "show", task_id])
    assert result.exit_code == 0, result.output
    assert "Work review: ship" in result.output
    assert "Work reviewed at:" in result.output
