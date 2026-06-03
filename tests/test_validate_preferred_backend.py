"""Tests for fn-586 `preferred_backend` task field validation.

fn-614 task .3: session-id env renamed JOBCTL_SESSION_ID → PLANCTL_SESSION_ID.

Covers the allowlist `validate` check in `run_validate.py`:
- None / "claude" / "codex" accepted
- empty string, "opus", other strings rejected
- non-string values (int) rejected
- error lands in the `errors` list of the `{valid, errors, warnings}` envelope

Field is dormant infrastructure — no setter verb, no routing, no surface in
`planctl show`. These tests only verify the validator and the normalize default
(round-tripped via the on-disk task JSON the scaffold path emits).
"""

from __future__ import annotations

import json
import os
import subprocess

from click.testing import CliRunner  # type: ignore[import-untyped]
from planctl.cli import cli

from .conftest import seed_epic


def _parse_json_stream(text: str) -> list[dict]:
    """Extract all JSON objects from a string that may contain pretty-printed
    or compact JSON documents concatenated together."""
    decoder = json.JSONDecoder()
    docs = []
    idx = 0
    while idx < len(text):
        while idx < len(text) and text[idx] in " \t\n\r":
            idx += 1
        if idx >= len(text):
            break
        obj, end = decoder.raw_decode(text, idx)
        docs.append(obj)
        idx = end
    return docs


def _create_project(tmp_path, monkeypatch):
    """Init a planctl project (git-init so validate path-checks resolve)."""
    monkeypatch.setenv("PLANCTL_SESSION_ID", "test-preferred-backend-fixture")
    monkeypatch.chdir(tmp_path)
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    runner = CliRunner()
    result = runner.invoke(cli, ["init"])
    assert result.exit_code == 0, result.output
    return tmp_path


def _seed_epic_with_task(project_path):
    """Scaffold an epic + 1 task, null out multi-repo fields so legacy-path
    validate skips path checks, return (epic_id, task_id)."""
    env = {**os.environ, "PLANCTL_SESSION_ID": "test-preferred-backend-fixture"}
    epic_id, task_ids = seed_epic(
        project_path,
        title="preferred_backend test epic",
        n_tasks=1,
        env=env,
    )
    epic_path = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    data = json.loads(epic_path.read_text())
    data["primary_repo"] = None
    data["touched_repos"] = None
    epic_path.write_text(json.dumps(data))

    task_path = project_path / ".planctl" / "tasks" / f"{task_ids[0]}.json"
    tdata = json.loads(task_path.read_text())
    tdata["target_repo"] = None
    task_path.write_text(json.dumps(tdata))

    return epic_id, task_ids[0]


def _patch_task(project_path, task_id: str, **fields) -> None:
    task_path = project_path / ".planctl" / "tasks" / f"{task_id}.json"
    data = json.loads(task_path.read_text())
    data.update(fields)
    task_path.write_text(json.dumps(data))


def _run_validate(project_path, epic_id: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "PLANCTL_SESSION_ID": "test-preferred-backend-fixture"}
    return subprocess.run(
        ["planctl", "validate", "--epic", epic_id],
        cwd=str(project_path),
        env=env,
        capture_output=True,
        text=True,
    )


# ---------------------------------------------------------------------------
# Accept: None, "claude", "codex"
# ---------------------------------------------------------------------------


def test_validate_accepts_null_preferred_backend(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _seed_epic_with_task(project_path)
    _patch_task(project_path, task_id, preferred_backend=None)

    result = _run_validate(project_path, epic_id)
    assert result.returncode == 0, (
        f"validate should accept null preferred_backend:\n{result.stdout}\n{result.stderr}"
    )


def test_validate_accepts_claude_preferred_backend(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _seed_epic_with_task(project_path)
    _patch_task(project_path, task_id, preferred_backend="claude")

    result = _run_validate(project_path, epic_id)
    assert result.returncode == 0, (
        f"validate should accept preferred_backend='claude':\n{result.stdout}\n{result.stderr}"
    )


def test_validate_accepts_codex_preferred_backend(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _seed_epic_with_task(project_path)
    _patch_task(project_path, task_id, preferred_backend="codex")

    result = _run_validate(project_path, epic_id)
    assert result.returncode == 0, (
        f"validate should accept preferred_backend='codex':\n{result.stdout}\n{result.stderr}"
    )


# ---------------------------------------------------------------------------
# Reject: empty string, unknown strings, non-string values
# ---------------------------------------------------------------------------


def _envelope_errors(stdout: str) -> list[str]:
    """Pull the `errors` list out of the `{valid, errors, warnings}` envelope."""
    docs = _parse_json_stream(stdout)
    for doc in docs:
        if "valid" in doc and "errors" in doc:
            return doc["errors"]
    raise AssertionError(f"No validate envelope found in stdout:\n{stdout!r}")


def test_validate_rejects_empty_string_preferred_backend(tmp_path, monkeypatch):
    """Empty string is rejected distinctly from None — hand-edited JSON should
    not silently coerce '' to null."""
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _seed_epic_with_task(project_path)
    _patch_task(project_path, task_id, preferred_backend="")

    result = _run_validate(project_path, epic_id)
    assert result.returncode == 1, (
        f"validate should reject empty preferred_backend:\n{result.stdout}"
    )
    errors = _envelope_errors(result.stdout)
    assert any("preferred_backend" in e and task_id in e for e in errors), (
        f"Expected preferred_backend error mentioning {task_id} in errors: {errors}"
    )


def test_validate_rejects_unknown_preferred_backend(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _seed_epic_with_task(project_path)
    _patch_task(project_path, task_id, preferred_backend="opus")

    result = _run_validate(project_path, epic_id)
    assert result.returncode == 1, (
        f"validate should reject preferred_backend='opus':\n{result.stdout}"
    )
    errors = _envelope_errors(result.stdout)
    assert any("preferred_backend" in e and "opus" in e for e in errors), (
        f"Expected error mentioning 'preferred_backend' and 'opus': {errors}"
    )


def test_validate_rejects_non_string_preferred_backend(tmp_path, monkeypatch):
    """Non-string values (e.g. int) must also be rejected — they fall outside
    the allowlist."""
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _seed_epic_with_task(project_path)
    _patch_task(project_path, task_id, preferred_backend=5)

    result = _run_validate(project_path, epic_id)
    assert result.returncode == 1, (
        f"validate should reject preferred_backend=5:\n{result.stdout}"
    )
    errors = _envelope_errors(result.stdout)
    assert any("preferred_backend" in e for e in errors), (
        f"Expected preferred_backend error: {errors}"
    )
