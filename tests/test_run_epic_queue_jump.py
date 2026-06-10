"""Tests for planctl epic queue-jump — the board-priority flip verb.

queue-jump flips queue_jump=true on an existing epic and rides queue_jump=True
on the planctl_invocation envelope so keeper folds the priority signal and
projects the `!`-prefixed sort_path. The `/plan:next` skill consumes this verb.

Mutating verbs resolve the session id from CLAUDE_CODE_SESSION_ID; these tests
set it explicitly.

Cases:
- false → true: verb writes queue_jump=true on the epic JSON and the success
  envelope's planctl_invocation carries queue_jump:true.
- already true: idempotent read-only short-circuit (no JSON rewrite, readonly
  envelope, no mutating chore commit).
- missing epic → error envelope, exit 1.
- queue-jump is NOT in VALIDATION_RESTAMP_VERBS (board-priority, not structural).
"""

from __future__ import annotations

import json
import os
import subprocess

import pytest
from click.testing import CliRunner
from planctl.cli import cli

_ENV = {**os.environ, "CLAUDE_CODE_SESSION_ID": "test-queue-jump-fixture"}


def _create_project(tmp_path, monkeypatch):
    """Init a planctl project under a fresh git repo."""
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-queue-jump-fixture")
    monkeypatch.chdir(tmp_path)
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    runner = CliRunner()
    result = runner.invoke(cli, ["init"], env=_ENV)
    assert result.exit_code == 0, result.output
    return tmp_path


def _invoke(args: list[str]) -> tuple[int, dict | None, str]:
    runner = CliRunner()
    result = runner.invoke(cli, args, env=_ENV)
    obj = None
    for line in result.output.strip().splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
    return result.exit_code, obj, result.output


def _read_epic(project_path, epic_id) -> dict:
    epic_path = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    return json.loads(epic_path.read_text())


def _make_epic() -> str:
    code, obj, output = _invoke(["epic", "create", "--title", "Jumpable epic"])
    assert code == 0, output
    assert obj is not None, f"epic create produced no JSON:\n{output}"
    return obj["epic"]["id"]


def test_queue_jump_false_to_true_sets_flag_and_envelope(tmp_path, monkeypatch):
    """false → true: writes queue_jump on the JSON; envelope carries queue_jump:true."""
    _create_project(tmp_path, monkeypatch)
    epic_id = _make_epic()

    # The create path leaves queue_jump unset on the persisted JSON
    # (normalize_epic defaults it to False on load); the verb keys off
    # `is True`, so the unset/False state takes the mutating path.
    before = _read_epic(tmp_path, epic_id)
    assert before.get("queue_jump") is not True

    code, obj, output = _invoke(["epic", "queue-jump", epic_id])
    assert code == 0, f"queue-jump failed:\n{output}"
    assert obj is not None
    assert obj.get("epic_id") == epic_id
    assert obj.get("short_circuited") is False

    after = _read_epic(tmp_path, epic_id)
    assert after.get("queue_jump") is True

    inv = obj.get("planctl_invocation") or {}
    assert inv.get("op") == "queue-jump"
    assert inv.get("target") == epic_id
    assert inv.get("queue_jump") is True


@pytest.mark.real_git
def test_queue_jump_already_true_short_circuits_readonly(tmp_path, monkeypatch):
    """already true: read-only short-circuit — no JSON rewrite, no mutating commit."""
    _create_project(tmp_path, monkeypatch)
    epic_id = _make_epic()

    code, _, output = _invoke(["epic", "queue-jump", epic_id])
    assert code == 0, output

    # Record the JSON state and the commit count after the first (mutating) flip.
    first = _read_epic(tmp_path, epic_id)
    assert first.get("queue_jump") is True
    log_before = subprocess.run(
        ["git", "log", "--oneline"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=True,
    ).stdout

    code, obj, output = _invoke(["epic", "queue-jump", epic_id])
    assert code == 0, f"second queue-jump failed:\n{output}"
    assert obj is not None
    assert obj.get("short_circuited") is True

    # No second mutating commit landed (readonly envelope has NULL subject).
    log_after = subprocess.run(
        ["git", "log", "--oneline"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert log_after == log_before

    # JSON unchanged (updated_at not bumped on the read-only path).
    second = _read_epic(tmp_path, epic_id)
    assert second == first

    inv = obj.get("planctl_invocation") or {}
    assert inv.get("op") == "queue-jump"
    assert inv.get("subject") is None
    assert inv.get("files") is None


def test_queue_jump_missing_epic_errors(tmp_path, monkeypatch):
    _create_project(tmp_path, monkeypatch)
    code, _, output = _invoke(["epic", "queue-jump", "fn-9999-no-epic"])
    assert code != 0
    assert "not found" in output.lower() or "fn-9999" in output


def test_queue_jump_not_in_validation_restamp_verbs():
    """queue_jump is board-priority, not structural — never re-stamps the marker."""
    from planctl.validation_restamp import VALIDATION_RESTAMP_VERBS

    assert "queue-jump" not in VALIDATION_RESTAMP_VERBS
