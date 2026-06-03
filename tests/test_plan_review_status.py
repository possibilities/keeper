"""Tests for plan_review_status field and epic set-plan-review-status command."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from click.testing import CliRunner
from planctl.cli import cli

from .conftest import parse_cli_output


@pytest.fixture
def project(tmp_path, monkeypatch):
    """Create a throwaway planctl project and chdir to it."""
    monkeypatch.setenv("PLANCTL_SESSION_ID", "test-session-fixture")
    monkeypatch.chdir(tmp_path)
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


# --- Field defaults ---


def test_fresh_epic_has_unknown_plan_review_status(project: Path):
    epic_id = _create_epic()
    result = _invoke(["show", epic_id])
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["epic"]["plan_review_status"] == "unknown"
    assert payload["epic"]["plan_reviewed_at"] is None


def test_normalize_epic_defaults_on_old_schema(project: Path):
    """Pre-existing epics without the fields still load via normalize_epic."""
    epic_id = _create_epic()
    # Manually strip the new fields to simulate an old-schema epic
    epic_path = project / ".planctl" / "epics" / f"{epic_id}.json"
    epic_def = json.loads(epic_path.read_text())
    epic_def.pop("plan_review_status", None)
    epic_def.pop("plan_reviewed_at", None)
    epic_path.write_text(json.dumps(epic_def, indent=2) + "\n")

    result = _invoke(["show", epic_id])
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["epic"]["plan_review_status"] == "unknown"
    assert payload["epic"]["plan_reviewed_at"] is None


# --- set-plan-review-status command ---


def test_set_plan_review_status_ship(project: Path):
    epic_id = _create_epic()
    result = _invoke(["epic", "set-plan-review-status", epic_id, "--status", "ship"])
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["success"] is True
    assert payload["plan_review_status"] == "ship"
    assert payload["plan_reviewed_at"] is not None


def test_set_plan_review_status_ship_persists(project: Path):
    epic_id = _create_epic()
    _invoke(["epic", "set-plan-review-status", epic_id, "--status", "ship"])

    result = _invoke(["show", epic_id])
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["epic"]["plan_review_status"] == "ship"
    assert payload["epic"]["plan_reviewed_at"] is not None


def test_set_plan_review_status_needs_work(project: Path):
    epic_id = _create_epic()
    result = _invoke(
        ["epic", "set-plan-review-status", epic_id, "--status", "needs_work"]
    )
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["success"] is True
    assert payload["plan_review_status"] == "needs_work"
    assert payload["plan_reviewed_at"] is not None


def test_set_plan_review_status_unknown(project: Path):
    """Can reset back to unknown."""
    epic_id = _create_epic()
    _invoke(["epic", "set-plan-review-status", epic_id, "--status", "ship"])
    result = _invoke(["epic", "set-plan-review-status", epic_id, "--status", "unknown"])
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["plan_review_status"] == "unknown"


def test_set_plan_review_status_updates_reviewed_at_on_change(project: Path):
    """Changing status updates plan_reviewed_at."""
    epic_id = _create_epic()
    r1 = _invoke(["epic", "set-plan-review-status", epic_id, "--status", "ship"])
    t1 = json.loads(r1.output)["plan_reviewed_at"]

    r2 = _invoke(["epic", "set-plan-review-status", epic_id, "--status", "needs_work"])
    t2 = json.loads(r2.output)["plan_reviewed_at"]

    # Both should have timestamps; t2 >= t1 (monotone)
    assert t1 is not None
    assert t2 is not None
    assert t2 >= t1


def test_set_plan_review_status_invalid_status_exits_nonzero(project: Path):
    epic_id = _create_epic()
    result = _invoke(["epic", "set-plan-review-status", epic_id, "--status", "bogus"])
    assert result.exit_code != 0


def test_set_plan_review_status_missing_epic_exits_nonzero(project: Path):
    result = _invoke(
        [
            "epic",
            "set-plan-review-status",
            "fn-99-nonexistent",
            "--status",
            "ship",
        ]
    )
    assert result.exit_code != 0


# --- planctl show text output ---


def test_show_epic_text_surfaces_plan_review_status(project: Path):
    epic_id = _create_epic()
    result = _invoke(["--format", "human", "show", epic_id])
    assert result.exit_code == 0, result.output
    assert "Plan review: unknown" in result.output


def test_show_epic_text_surfaces_plan_reviewed_at_when_set(project: Path):
    epic_id = _create_epic()
    _invoke(["epic", "set-plan-review-status", epic_id, "--status", "ship"])
    result = _invoke(["--format", "human", "show", epic_id])
    assert result.exit_code == 0, result.output
    assert "Plan review: ship" in result.output
    assert "Plan reviewed at:" in result.output
