"""Tests for `planctl init` advice-file drop (CLAUDE.md + AGENTS.md)."""

from __future__ import annotations

import subprocess
from pathlib import Path

from click.testing import CliRunner
from planctl.cli import cli
from planctl.run_init import CLAUDE_MD_CONTENT


def _planctl_dir(project: Path) -> Path:
    return project / ".planctl"


def _git_commit_count(repo: Path) -> int:
    result = subprocess.run(
        ["git", "rev-list", "--count", "HEAD"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    )
    return int(result.stdout.strip())


def _git_head_message(repo: Path) -> str:
    result = subprocess.run(
        ["git", "log", "-1", "--format=%B"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def test_init_drops_claude_md(project: Path) -> None:
    claude_md = _planctl_dir(project) / "CLAUDE.md"
    assert claude_md.exists()
    assert claude_md.read_text(encoding="utf-8") == CLAUDE_MD_CONTENT


def test_init_drops_agents_md_as_relative_symlink(project: Path) -> None:
    agents_md = _planctl_dir(project) / "AGENTS.md"
    assert agents_md.is_symlink()
    # Relative target so the link survives moving the project tree.
    assert agents_md.readlink() == Path("CLAUDE.md")
    # And it actually resolves to the same content as CLAUDE.md.
    assert agents_md.read_text(encoding="utf-8") == CLAUDE_MD_CONTENT


def test_init_is_idempotent_and_preserves_human_edits(
    project: Path, monkeypatch
) -> None:
    """Re-running init must not clobber a CLAUDE.md the human has edited."""
    claude_md = _planctl_dir(project) / "CLAUDE.md"
    custom = "# my notes\nthe human modified this file\n"
    claude_md.write_text(custom, encoding="utf-8")

    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-session-fixture")
    runner = CliRunner()
    result = runner.invoke(cli, ["init"])
    assert result.exit_code == 0, result.output

    assert claude_md.read_text(encoding="utf-8") == custom


def test_init_backfills_existing_project(tmp_path: Path, monkeypatch) -> None:
    """A planctl project that pre-dates the advice-file drop gets backfilled."""
    import json

    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-session-fixture")
    monkeypatch.chdir(tmp_path)

    planctl_dir = tmp_path / ".planctl"
    for sub in ("epics", "specs", "tasks", "state/tasks", "state/locks"):
        (planctl_dir / sub).mkdir(parents=True, exist_ok=True)
    (planctl_dir / "meta.json").write_text(json.dumps({"schema_version": 1}))
    (planctl_dir / ".gitignore").write_text("state/\n")

    assert not (planctl_dir / "CLAUDE.md").exists()
    assert not (planctl_dir / "AGENTS.md").exists()

    runner = CliRunner()
    result = runner.invoke(cli, ["init"])
    assert result.exit_code == 0, result.output

    assert (planctl_dir / "CLAUDE.md").read_text(encoding="utf-8") == CLAUDE_MD_CONTENT
    assert (planctl_dir / "AGENTS.md").is_symlink()
    assert (planctl_dir / "AGENTS.md").readlink() == Path("CLAUDE.md")


def test_init_self_commits_without_session_id(tmp_path: Path, monkeypatch) -> None:
    """`init` in a git repo self-commits its bootstrap files with no session id.

    Exercises the explicit-payload route: with CLAUDE_CODE_SESSION_ID unset, init
    must still land a clean `chore(planctl): init <name>` commit (no RuntimeError,
    no Session-Id trailer) and leave a clean working tree.
    """
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
    monkeypatch.chdir(tmp_path)
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    # An initial commit so HEAD exists for the prev-op trailer.
    (tmp_path / "README.md").write_text("# repo\n")
    subprocess.run(
        ["git", "add", "README.md"], cwd=tmp_path, check=True, capture_output=True
    )
    subprocess.run(
        ["git", "commit", "-m", "chore: initial commit"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
    )

    before = _git_commit_count(tmp_path)
    runner = CliRunner()
    result = runner.invoke(cli, ["init"])
    assert result.exit_code == 0, result.output

    # Exactly one new commit, with the init subject and no Session-Id trailer.
    assert _git_commit_count(tmp_path) == before + 1
    msg = _git_head_message(tmp_path)
    assert msg.splitlines()[0] == f"chore(planctl): init {tmp_path.name}"
    assert "Session-Id:" not in msg

    # Bootstrap files are tracked in HEAD and the working tree is clean.
    tracked = subprocess.run(
        ["git", "ls-files", ".planctl/"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert ".planctl/meta.json" in tracked
    assert ".planctl/.gitignore" in tracked
    assert ".planctl/CLAUDE.md" in tracked
    assert ".planctl/AGENTS.md" in tracked
    status = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert status.strip() == ""


def test_init_idempotent_rerun_creates_no_commit(tmp_path: Path, monkeypatch) -> None:
    """A second `init` that writes nothing produces no new commit (no empty commit)."""
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
    monkeypatch.chdir(tmp_path)
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    (tmp_path / "README.md").write_text("# repo\n")
    subprocess.run(
        ["git", "add", "README.md"], cwd=tmp_path, check=True, capture_output=True
    )
    subprocess.run(
        ["git", "commit", "-m", "chore: initial commit"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
    )

    runner = CliRunner()
    assert runner.invoke(cli, ["init"]).exit_code == 0
    after_first = _git_commit_count(tmp_path)

    # Re-run: nothing new to write, so no commit lands and the tree stays clean.
    result = runner.invoke(cli, ["init"])
    assert result.exit_code == 0, result.output
    assert _git_commit_count(tmp_path) == after_first
    status = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert status.strip() == ""


def test_init_in_non_git_dir_writes_files_without_commit(
    tmp_path: Path, monkeypatch
) -> None:
    """Outside a git work tree, init writes the bootstrap files and exits 0."""
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
    monkeypatch.chdir(tmp_path)

    runner = CliRunner()
    result = runner.invoke(cli, ["init"])
    assert result.exit_code == 0, result.output

    planctl_dir = _planctl_dir(tmp_path)
    assert (planctl_dir / "meta.json").exists()
    assert (planctl_dir / "CLAUDE.md").read_text(encoding="utf-8") == CLAUDE_MD_CONTENT
    assert (planctl_dir / "AGENTS.md").is_symlink()
    assert not (tmp_path / ".git").exists()
