"""Tests for planctl epic close (fn-559 — audit-required flag torn down).

Mutating verbs resolve the session id from CLAUDE_CODE_SESSION_ID; these
tests set it explicitly.

`epic close` stamps `closer_done_at` only. The fn-521 `--audit-required` /
`--no-audit-required` flag and the parity `auditor_done_at` stamp were removed
when the standalone auditor concept was torn down (the audit now runs inline
inside `/plan:close` before the close mutation).
"""

from __future__ import annotations

import contextlib
import json
import os

from click.testing import CliRunner
from planctl.cli import cli

_ENV = {**os.environ, "CLAUDE_CODE_SESSION_ID": "test-epic-close-fixture"}


def _create_project(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-epic-close-fixture")
    monkeypatch.chdir(tmp_path)
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
            with contextlib.suppress(json.JSONDecodeError):
                obj = json.loads(line)
            break
    return result.exit_code, obj, result.output


def _read_epic(project_path, epic_id) -> dict:
    epic_path = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    return json.loads(epic_path.read_text())


def test_close_stamps_only_closer_done_at(tmp_path, monkeypatch):
    """`epic close` stamps closer_done_at and never writes auditor_done_at."""
    _create_project(tmp_path, monkeypatch)
    code, obj, output = _invoke(["epic", "create", "--title", "Close"])
    assert code == 0, output
    epic_id = obj["epic"]["id"]

    code, _, output = _invoke(["epic", "close", epic_id, "--force"])
    assert code == 0, output

    epic = _read_epic(tmp_path, epic_id)
    assert epic.get("closer_done_at") is not None
    assert "auditor_done_at" not in epic


def test_close_rejects_removed_audit_required_flag(tmp_path, monkeypatch):
    """The fn-521 --audit-required / --no-audit-required flag is gone (fn-559)."""
    _create_project(tmp_path, monkeypatch)
    code, obj, output = _invoke(["epic", "create", "--title", "Flag gone"])
    assert code == 0, output
    epic_id = obj["epic"]["id"]

    runner = CliRunner()
    result = runner.invoke(
        cli, ["epic", "close", epic_id, "--force", "--no-audit-required"], env=_ENV
    )
    # click rejects the unknown option with a usage error (exit 2).
    assert result.exit_code != 0
    assert "no such option" in result.output.lower() or "no-audit-required" in (
        result.output.lower()
    )


def test_close_envelope_carries_planctl_invocation(tmp_path, monkeypatch):
    """Close envelope carries the standard planctl_invocation with op=close."""
    _create_project(tmp_path, monkeypatch)
    code, obj, _ = _invoke(["epic", "create", "--title", "Envelope test"])
    epic_id = obj["epic"]["id"]
    runner = CliRunner()
    result = runner.invoke(cli, ["epic", "close", epic_id, "--force"], env=_ENV)
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output.strip().splitlines()[-1])
    inv = payload.get("planctl_invocation") or {}
    assert inv.get("op") == "close"
    assert inv.get("target") == epic_id
