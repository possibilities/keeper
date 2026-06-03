"""Tests for `planctl worker resume` subcommand (arthack divergence).

fn-614 task .3: session-id env renamed JOBCTL_SESSION_ID → PLANCTL_SESSION_ID.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from click.testing import CliRunner
from planctl.cli import cli


@pytest.fixture
def project(tmp_path, monkeypatch):
    """Create a throwaway planctl project and chdir to it.

    fn-589 task .1 (item 2): scaffold + refine-apply now run filesystem-repo
    integrity at mint time, so the project root must be a real git repo for
    seed_epic to succeed.
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
    return CliRunner(mix_stderr=False).invoke(cli, args)


def _make_task(project: Path, files_line: str | None = "app/foo.py, app/bar.py") -> str:
    """Scaffold an epic + task; optionally inject a **Files:** line into the spec."""
    from .conftest import seed_epic

    _epic_id, task_ids = seed_epic(project, title="Test epic", n_tasks=1)
    task_id = task_ids[0]

    if files_line is not None:
        spec_path = project / ".planctl" / "specs" / f"{task_id}.md"
        spec_path.write_text(
            f"## Description\n\n**Files:** {files_line}\n\n## Acceptance\n\n- [ ] done\n",
            encoding="utf-8",
        )

    return task_id


def test_worker_resume_happy_path(project: Path, monkeypatch):
    import planctl.run_worker_resume as m

    monkeypatch.setattr(m, "_read_git_state", lambda: "M app/foo.py")

    task_id = _make_task(project)
    result = _invoke(["worker", "resume", task_id])

    assert result.exit_code == 0, result.output
    out = result.output
    assert f"TASK_ID: {task_id}" in out
    assert "EPIC_ID:" in out
    assert "PLANCTL: planctl" in out
    assert "CONTEXT:" in out
    assert "app/foo.py" in out  # from git state
    assert "Files changed:" in out
    assert "app/bar.py" in out  # from spec **Files:**


def test_worker_resume_missing_files_block(project: Path, monkeypatch):
    import planctl.run_worker_resume as m

    monkeypatch.setattr(m, "_read_git_state", lambda: "")

    task_id = _make_task(project, files_line=None)
    spec_path = project / ".planctl" / "specs" / f"{task_id}.md"
    spec_path.write_text(
        "## Description\n\nNo files listed here.\n\n## Acceptance\n\n- [ ] done\n",
        encoding="utf-8",
    )

    result = CliRunner(mix_stderr=False).invoke(cli, ["worker", "resume", task_id])

    assert result.exit_code == 0, result.output
    assert "planctl cat" in result.output
    assert "could not parse" in (result.stderr or "")


def test_worker_resume_unknown_task_id(project: Path):
    result = _invoke(["worker", "resume", "fn-99-ghost.9"])
    assert result.exit_code != 0
    payload = json.loads(result.output)
    assert payload["success"] is False
    assert "fn-99-ghost.9" in payload["error"]


def test_worker_resume_group_help():
    result = _invoke(["worker", "--help"])
    assert result.exit_code == 0
    assert "resume" in result.output


def test_worker_resume_json_envelope(project: Path, monkeypatch):
    import planctl.run_worker_resume as m

    monkeypatch.setattr(m, "_read_git_state", lambda: "")

    task_id = _make_task(project)
    result = _invoke(["worker", "resume", task_id])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["success"] is True
    assert "prompt" in payload
    assert f"TASK_ID: {task_id}" in payload["prompt"]
    assert "PLANCTL: planctl" in payload["prompt"]
    assert "reopened" not in payload


def _set_status(project: Path, task_id: str, status: str) -> None:
    """Write runtime state directly — bypasses the normal claim/done flow."""
    state_path = project / ".planctl" / "state" / "tasks" / f"{task_id}.state.json"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(
        json.dumps({"status": status, "updated_at": "2026-04-18T00:00:00Z"}) + "\n",
        encoding="utf-8",
    )


def test_worker_resume_done_task_does_not_flip(project: Path, monkeypatch):
    """`done` task → resume emits prompt without flipping state.

    Under the commit-then-done worker contract, observing `done` here means the
    source commit already shipped (the predecessor reached Phase 6). The resume
    helper just emits the respawn prompt; the respawned worker decides what to
    do (typically: verify the trailer commit, call `planctl done` idempotently).
    """
    import planctl.run_worker_resume as m

    monkeypatch.setattr(m, "_read_git_state", lambda: "")

    task_id = _make_task(project)
    _set_status(project, task_id, "done")

    result = CliRunner(mix_stderr=False).invoke(cli, ["worker", "resume", task_id])

    assert result.exit_code == 0, result.output
    stderr = result.stderr or ""
    assert "reopened" not in stderr
    assert "'done'" in stderr  # status warning still surfaces

    state_path = project / ".planctl" / "state" / "tasks" / f"{task_id}.state.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["status"] == "done"


def test_worker_resume_done_task_json_status_unchanged(project: Path, monkeypatch):
    import planctl.run_worker_resume as m

    monkeypatch.setattr(m, "_read_git_state", lambda: "")

    task_id = _make_task(project)
    _set_status(project, task_id, "done")

    result = _invoke(["worker", "resume", task_id])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["success"] is True
    assert "reopened" not in payload
    assert payload["status"] == "done"


def test_worker_resume_in_progress_is_noop(project: Path, monkeypatch):
    """Already-in_progress tasks are not mutated."""
    import planctl.run_worker_resume as m

    monkeypatch.setattr(m, "_read_git_state", lambda: "")

    task_id = _make_task(project)
    _set_status(project, task_id, "in_progress")

    before = (
        project / ".planctl" / "state" / "tasks" / f"{task_id}.state.json"
    ).read_text(encoding="utf-8")

    result = CliRunner(mix_stderr=False).invoke(cli, ["worker", "resume", task_id])

    assert result.exit_code == 0, result.output
    assert "reopened" not in (result.stderr or "")

    after = (
        project / ".planctl" / "state" / "tasks" / f"{task_id}.state.json"
    ).read_text(encoding="utf-8")
    assert before == after


def test_worker_resume_tier_set_emits_stderr_note(project: Path, monkeypatch):
    """A persisted non-null tier surfaces as a stderr note AND in the envelope.

    fn-589 task .1 (item 5): ``tier`` now rides the envelope so /plan:work's
    cold-resume can branch on it without a separate ``task show`` round trip.
    """
    import planctl.run_worker_resume as m

    monkeypatch.setattr(m, "_read_git_state", lambda: "")

    task_id = _make_task(project)
    set_tier = CliRunner().invoke(cli, ["task", "set-tier", task_id, "--tier", "high"])
    assert set_tier.exit_code == 0, set_tier.output

    result = CliRunner(mix_stderr=False).invoke(cli, ["worker", "resume", task_id])

    assert result.exit_code == 0, result.output
    stderr = result.stderr or ""
    assert f"Note: task {task_id} tier is 'high'" in stderr
    # Stdout envelope shape now carries the tier (fn-589 task .1, item 5).
    payload = json.loads(result.output)
    assert set(payload.keys()) >= {"success", "prompt", "task_id", "status", "tier"}
    assert payload["tier"] == "high"


def test_worker_resume_tier_null_emits_raw_note(project: Path, monkeypatch):
    """A null persisted tier surfaces a raw "tier is None" note.

    fn-594: the cold-resume heuristic note branch was deleted (build-forward
    — scaffold / refine-apply now reject missing tier at mint time). Legacy
    on-disk null-tier records still load (normalize_task's load-time None
    default), and the envelope still carries an explicit JSON null so the
    skill consumer can branch on it; the launcher fails loud on null at
    run time and the human remediates via ``/plan:plan <epic_id>`` refine.
    """
    import planctl.run_worker_resume as m

    monkeypatch.setattr(m, "_read_git_state", lambda: "")

    task_id = _make_task(project)
    # fn-594: seed_epic / scaffold now write `tier: medium` by default
    # (the field is required at mint time). To simulate a pre-fn-594
    # legacy on-disk record, hand-null the persisted task_def — this is
    # the only path to null tier in current flows.
    task_path = project / ".planctl" / "tasks" / f"{task_id}.json"
    task_def = json.loads(task_path.read_text(encoding="utf-8"))
    task_def["tier"] = None
    task_path.write_text(json.dumps(task_def), encoding="utf-8")
    assert task_def.get("tier") is None

    result = CliRunner(mix_stderr=False).invoke(cli, ["worker", "resume", task_id])

    assert result.exit_code == 0, result.output
    stderr = result.stderr or ""
    # fn-594: the cold-resume heuristic message branch was deleted. Any
    # non-string tier (None on a legacy record, or an unexpected type)
    # surfaces a raw `tier is <repr>` note now.
    assert f"Note: task {task_id} tier is None" in stderr
    assert "cold-resume heuristic" not in stderr
    # Envelope carries an explicit JSON null for tier (key present, value None).
    payload = json.loads(result.output)
    assert "tier" in payload
    assert payload["tier"] is None


def test_worker_resume_blocked_warns_leaves_alone(project: Path, monkeypatch):
    """`blocked` gets a warn but state is not flipped."""
    import planctl.run_worker_resume as m

    monkeypatch.setattr(m, "_read_git_state", lambda: "")

    task_id = _make_task(project)
    _set_status(project, task_id, "blocked")

    result = CliRunner(mix_stderr=False).invoke(cli, ["worker", "resume", task_id])

    assert result.exit_code == 0, result.output
    stderr = result.stderr or ""
    assert "reopened" not in stderr
    assert "'blocked'" in stderr

    state_path = project / ".planctl" / "state" / "tasks" / f"{task_id}.state.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["status"] == "blocked"
