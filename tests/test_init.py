"""Tests for `planctl init` advice-file drop (CLAUDE.md + AGENTS.md)."""

from __future__ import annotations

from pathlib import Path

from click.testing import CliRunner
from planctl.cli import cli
from planctl.run_init import CLAUDE_MD_CONTENT


def _planctl_dir(project: Path) -> Path:
    return project / ".planctl"


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
