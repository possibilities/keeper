"""Tests for non-blocking validation warnings in set-primary-repo and set-touched-repos.

Cases:
- epic set-primary-repo with a nonexistent path: warning in envelope + stderr, write succeeds, exit 0.
- epic set-primary-repo with a path that exists but has no .git/: warning in envelope + stderr, write succeeds, exit 0.
- epic set-primary-repo with a valid git repo: no warning, normal envelope.
- epic set-touched-repos with one bad path in a list of three: one warning per bad path.
"""

from __future__ import annotations

import json
import os
import subprocess

from click.testing import CliRunner  # type: ignore[import-untyped]
from planctl.cli import cli

from .conftest import run_cli

_ENV = {**os.environ, "CLAUDE_CODE_SESSION_ID": "test-set-primary-repo-warning-fixture"}


def _create_project(tmp_path, monkeypatch):
    """Init a planctl project in tmp_path and return the path."""
    monkeypatch.setenv(
        "CLAUDE_CODE_SESSION_ID", "test-set-primary-repo-warning-fixture"
    )
    monkeypatch.chdir(tmp_path)
    runner = CliRunner()
    result = runner.invoke(cli, ["init"])
    assert result.exit_code == 0, result.output
    return tmp_path


def _create_epic() -> str:
    """Create an epic and return its ID."""
    runner = CliRunner()
    result = runner.invoke(
        cli,
        ["epic", "create", "--title", "Warning test epic"],
        env=_ENV,
    )
    assert result.exit_code == 0, result.output
    return json.loads(result.output.strip())["epic"]["id"]


def _read_epic_json(project_path, epic_id) -> dict:
    epic_path = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    return json.loads(epic_path.read_text())


def _run_planctl(args: list[str], cwd: str):
    return run_cli(args, cwd=cwd, env=_ENV)


def _init_git_repo(path) -> None:
    result = subprocess.run(
        ["git", "init"],
        cwd=str(path),
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"git init failed: {result.stderr}"


# ---------------------------------------------------------------------------
# epic set-primary-repo warning tests
# ---------------------------------------------------------------------------


def test_set_primary_repo_nonexistent_path_warns(tmp_path, monkeypatch):
    """set-primary-repo with a nonexistent path: warning in envelope + stderr, write succeeds, exit 0."""
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic()

    bogus_path = str(tmp_path / "does-not-exist")
    result = _run_planctl(
        ["epic", "set-primary-repo", epic_id, "--path", bogus_path],
        cwd=str(project_path),
    )

    # Exit 0 (non-blocking).
    assert result.returncode == 0, (
        f"Expected exit 0 even on bad path, got {result.returncode}.\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )

    # Value still written.
    epic_data = _read_epic_json(project_path, epic_id)
    import os as _os

    assert _os.path.normpath(epic_data["primary_repo"]) == _os.path.normpath(
        bogus_path
    ), f"primary_repo was not written: {epic_data['primary_repo']!r}"

    # Envelope contains warnings list with one entry.
    envelope = json.loads(result.stdout.strip().splitlines()[0])
    assert "warnings" in envelope, f"Expected warnings in envelope: {envelope}"
    assert len(envelope["warnings"]) == 1, (
        f"Expected 1 warning, got {envelope['warnings']}"
    )
    warning_text = envelope["warnings"][0]
    assert "does not exist" in warning_text, (
        f"Expected 'does not exist' in warning: {warning_text!r}"
    )
    assert "planctl validate" in warning_text, (
        f"Expected 'planctl validate' hint in warning: {warning_text!r}"
    )

    # WARN: line on stderr.
    assert "WARN:" in result.stderr, f"Expected WARN: on stderr, got: {result.stderr!r}"
    assert "does not exist" in result.stderr, (
        f"Expected 'does not exist' in stderr: {result.stderr!r}"
    )


def test_set_primary_repo_exists_but_no_git_warns(tmp_path, monkeypatch):
    """set-primary-repo with a path that exists but lacks .git/: warning emitted, write succeeds, exit 0."""
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic()

    no_git_dir = tmp_path / "no-git-dir"
    no_git_dir.mkdir()

    result = _run_planctl(
        ["epic", "set-primary-repo", epic_id, "--path", str(no_git_dir)],
        cwd=str(project_path),
    )

    assert result.returncode == 0, (
        f"Expected exit 0 even on path-without-.git, got {result.returncode}.\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )

    # Value written.
    epic_data = _read_epic_json(project_path, epic_id)
    assert epic_data["primary_repo"] == str(no_git_dir), (
        f"primary_repo was not written: {epic_data['primary_repo']!r}"
    )

    # Envelope warning.
    envelope = json.loads(result.stdout.strip().splitlines()[0])
    assert "warnings" in envelope, f"Expected warnings in envelope: {envelope}"
    assert len(envelope["warnings"]) == 1, (
        f"Expected 1 warning, got {envelope['warnings']}"
    )
    warning_text = envelope["warnings"][0]
    assert "no .git/" in warning_text, (
        f"Expected 'no .git/' in warning: {warning_text!r}"
    )

    # WARN: on stderr.
    assert "WARN:" in result.stderr, f"Expected WARN: on stderr, got: {result.stderr!r}"


def test_set_primary_repo_valid_git_repo_no_warning(tmp_path, monkeypatch):
    """set-primary-repo with a valid git repo: no warning, normal envelope."""
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic()

    valid_repo = tmp_path / "valid-repo"
    valid_repo.mkdir()
    _init_git_repo(valid_repo)

    result = _run_planctl(
        ["epic", "set-primary-repo", epic_id, "--path", str(valid_repo)],
        cwd=str(project_path),
    )

    assert result.returncode == 0, (
        f"Expected exit 0 for valid git repo, got {result.returncode}.\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )

    # Value written.
    epic_data = _read_epic_json(project_path, epic_id)
    assert epic_data["primary_repo"] == str(valid_repo), (
        f"primary_repo was not written: {epic_data['primary_repo']!r}"
    )

    # Envelope: warnings list is empty (or absent).
    envelope = json.loads(result.stdout.strip().splitlines()[0])
    assert envelope.get("warnings", []) == [], (
        f"Expected no warnings for valid repo, got: {envelope.get('warnings')}"
    )

    # No WARN: on stderr.
    assert "WARN:" not in result.stderr, (
        f"Expected no WARN: on stderr for valid repo, got: {result.stderr!r}"
    )


# ---------------------------------------------------------------------------
# epic set-touched-repos warning tests
# ---------------------------------------------------------------------------


def test_set_touched_repos_one_bad_path_warns(tmp_path, monkeypatch):
    """set-touched-repos with one bad path in a list of three: one warning per bad path."""
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic()

    valid_repo_1 = tmp_path / "valid-1"
    valid_repo_1.mkdir()
    _init_git_repo(valid_repo_1)

    valid_repo_2 = tmp_path / "valid-2"
    valid_repo_2.mkdir()
    _init_git_repo(valid_repo_2)

    bogus_path = str(tmp_path / "nonexistent-repo")

    paths_arg = f"{valid_repo_1},{bogus_path},{valid_repo_2}"
    result = _run_planctl(
        ["epic", "set-touched-repos", epic_id, "--paths", paths_arg],
        cwd=str(project_path),
    )

    assert result.returncode == 0, (
        f"Expected exit 0 even with one bad path, got {result.returncode}.\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )

    # All three paths written.
    epic_data = _read_epic_json(project_path, epic_id)
    assert len(epic_data["touched_repos"]) == 3, (
        f"Expected 3 touched_repos, got: {epic_data['touched_repos']}"
    )

    # Exactly one warning for the bad path.
    envelope = json.loads(result.stdout.strip().splitlines()[0])
    assert "warnings" in envelope, f"Expected warnings in envelope: {envelope}"
    assert len(envelope["warnings"]) == 1, (
        f"Expected exactly 1 warning for 1 bad path, got: {envelope['warnings']}"
    )
    warning_text = envelope["warnings"][0]
    assert "does not exist" in warning_text, (
        f"Expected 'does not exist' in warning: {warning_text!r}"
    )

    # One WARN: line on stderr.
    warn_lines = [
        line for line in result.stderr.splitlines() if line.startswith("WARN:")
    ]
    assert len(warn_lines) == 1, (
        f"Expected exactly 1 WARN: line on stderr, got {len(warn_lines)}: {result.stderr!r}"
    )


def test_set_touched_repos_all_bad_warns_each(tmp_path, monkeypatch):
    """set-touched-repos with two bad paths: one warning per bad path."""
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic()

    bogus1 = str(tmp_path / "no-such-dir-1")
    bogus2 = str(tmp_path / "no-such-dir-2")

    result = _run_planctl(
        ["epic", "set-touched-repos", epic_id, "--paths", f"{bogus1},{bogus2}"],
        cwd=str(project_path),
    )

    assert result.returncode == 0, (
        f"Expected exit 0 even with all bad paths, got {result.returncode}.\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )

    envelope = json.loads(result.stdout.strip().splitlines()[0])
    assert len(envelope.get("warnings", [])) == 2, (
        f"Expected 2 warnings for 2 bad paths, got: {envelope.get('warnings')}"
    )

    warn_lines = [
        line for line in result.stderr.splitlines() if line.startswith("WARN:")
    ]
    assert len(warn_lines) == 2, (
        f"Expected 2 WARN: lines on stderr, got {len(warn_lines)}: {result.stderr!r}"
    )


def test_set_touched_repos_valid_paths_no_warning(tmp_path, monkeypatch):
    """set-touched-repos with all valid git repos: no warnings."""
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic()

    valid_repo = tmp_path / "valid-repo"
    valid_repo.mkdir()
    _init_git_repo(valid_repo)

    result = _run_planctl(
        ["epic", "set-touched-repos", epic_id, "--paths", str(valid_repo)],
        cwd=str(project_path),
    )

    assert result.returncode == 0, (
        f"Expected exit 0 for valid repos, got {result.returncode}.\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )

    envelope = json.loads(result.stdout.strip().splitlines()[0])
    assert envelope.get("warnings", []) == [], (
        f"Expected no warnings for valid repos, got: {envelope.get('warnings')}"
    )
    assert "WARN:" not in result.stderr, (
        f"Expected no WARN: on stderr for valid repos, got: {result.stderr!r}"
    )
