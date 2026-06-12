"""Tests for multi-repo contract: epic create --touched-repos + planctl validate.

Contract pinned here:
- ``planctl epic create --touched-repos /nonexistent/path`` succeeds at create-time
  (no existence check; the path is stored verbatim).
- ``planctl validate --epic <id>`` fails with a clear error mentioning the missing path.
  Validate is the gate, not create.
"""

from __future__ import annotations

import json

from .conftest import run_cli

_ENV = {"CLAUDE_CODE_SESSION_ID": "test-multi-repo-create-validate-fixture"}


def _invoke(*args):
    return run_cli(list(args), env=_ENV)


def test_epic_create_touched_repos_nonexistent_succeeds(tmp_path, monkeypatch):
    """epic create --touched-repos with a nonexistent path: create succeeds, path stored verbatim."""
    monkeypatch.setenv(
        "CLAUDE_CODE_SESSION_ID", "test-multi-repo-create-validate-fixture"
    )
    monkeypatch.chdir(tmp_path)

    result = _invoke("init")
    assert result.exit_code == 0, result.output

    nonexistent = str(tmp_path / "does-not-exist")

    result = _invoke(
        "epic",
        "create",
        "--title",
        "Multi-repo create test",
        "--touched-repos",
        nonexistent,
    )
    assert result.exit_code == 0, (
        f"Expected exit 0 from epic create with nonexistent touched-repos path.\n"
        f"stdout: {result.output}"
    )

    payload = json.loads(result.output.strip().splitlines()[0])
    epic_id = payload["epic"]["id"]

    # Path must be stored in the epic JSON.
    epic_path = tmp_path / ".planctl" / "epics" / f"{epic_id}.json"
    epic_data = json.loads(epic_path.read_text())
    assert nonexistent in epic_data["touched_repos"], (
        f"Expected {nonexistent!r} in touched_repos, got {epic_data['touched_repos']!r}"
    )


def test_epic_create_touched_repos_nonexistent_validate_fails(tmp_path, monkeypatch):
    """validate --epic <id> fails when touched_repos contains a nonexistent path."""
    monkeypatch.setenv(
        "CLAUDE_CODE_SESSION_ID", "test-multi-repo-create-validate-fixture"
    )
    monkeypatch.chdir(tmp_path)

    result = _invoke("init")
    assert result.exit_code == 0, result.output

    nonexistent = str(tmp_path / "does-not-exist")

    create_result = _invoke(
        "epic",
        "create",
        "--title",
        "Validate gate test",
        "--touched-repos",
        nonexistent,
    )
    assert create_result.exit_code == 0, create_result.output
    payload = json.loads(create_result.output.strip().splitlines()[0])
    epic_id = payload["epic"]["id"]

    # validate --epic must report valid: false and mention the missing path.
    # Note: planctl validate exits 0 even when valid=false; check the envelope.
    # validate emits pretty-printed JSON (not compact NDJSON), so parse the full
    # output after stripping any trailing planctl_invocation line.
    validate_result = _invoke("validate", "--epic", epic_id)
    lines = validate_result.output.strip().splitlines()
    primary_lines = [
        ln for ln in lines if not ln.strip().startswith('{"planctl_invocation"')
    ]
    validate_payload = json.loads("\n".join(primary_lines))
    assert validate_payload["valid"] is False, (
        f"Expected valid=false from validate with nonexistent touched_repos path.\n"
        f"stdout: {validate_result.output}"
    )
    # Assert on the missing-path substring, not the full sentence (avoids brittle wording coupling).
    errors_text = " ".join(validate_payload.get("errors", []))
    assert "does not exist" in errors_text, (
        f"Expected 'does not exist' in validate errors.\n"
        f"errors: {validate_payload.get('errors')}"
    )
    assert nonexistent in errors_text, (
        f"Expected missing path {nonexistent!r} mentioned in validate errors.\n"
        f"errors: {validate_payload.get('errors')}"
    )
