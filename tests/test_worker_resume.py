"""Tests for `planctl worker resume` subcommand (arthack divergence).

`worker resume` is content-blind: it regenerates the out-of-band brief fresh
via ``planctl/brief.py`` and returns a typed envelope (``brief_ref`` handle +
a one-line process ``nudge``) — no narrative prose prompt, no ``planctl cat``
self-reference.

Mutating verbs resolve the session id from CLAUDE_CODE_SESSION_ID; the tests
below set it explicitly.
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

    scaffold + refine-apply run filesystem-repo integrity at mint time, so the
    project root must be a real git repo for seed_epic to succeed.
    """
    import subprocess

    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-session-fixture")
    monkeypatch.chdir(tmp_path)
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    runner = CliRunner()
    result = runner.invoke(cli, ["init"])
    assert result.exit_code == 0, result.output
    return tmp_path


def _invoke(args: list[str]):
    return CliRunner(mix_stderr=False).invoke(cli, args)


def _make_task(project: Path) -> str:
    """Scaffold an epic + task; return the task id."""
    from .conftest import seed_epic

    _epic_id, task_ids = seed_epic(project, title="Test epic", n_tasks=1)
    return task_ids[0]


def _brief_path(project: Path, task_id: str) -> Path:
    return project / ".planctl" / "state" / "briefs" / f"{task_id}.json"


def test_worker_resume_typed_envelope(project: Path, monkeypatch):
    """Resume returns the typed envelope with brief_ref + nudge + repos."""
    import planctl.run_worker_resume as m

    monkeypatch.setattr(m, "_read_git_state", lambda: "M app/foo.py")
    monkeypatch.setattr(m, "_find_source_commit_sha", lambda task_id: None)

    task_id = _make_task(project)
    result = _invoke(["worker", "resume", task_id])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["success"] is True

    # Typed fields present.
    assert payload["task_id"] == task_id
    assert "status" in payload
    assert "tier" in payload
    assert "target_repo" in payload
    assert "primary_repo" in payload

    # brief_ref is an absolute path pointing at the regenerated brief.
    brief_ref = payload["brief_ref"]
    assert Path(brief_ref).is_absolute()
    assert Path(brief_ref).exists()
    assert Path(brief_ref) == _brief_path(project, task_id).resolve()

    # nudge is a one-line process string — no spec prose, no planctl cat.
    nudge = payload["nudge"]
    assert "\n" not in nudge
    assert task_id in nudge
    assert "BRIEF_REF" in nudge
    assert "planctl cat" not in nudge

    # No narrative prose fields anywhere in the envelope.
    assert "prompt" not in payload
    assert "planctl cat" not in result.output
    assert "**Files:**" not in result.output
    assert "Files changed:" not in result.output
    assert "CONTEXT:" not in result.output


def test_worker_resume_regenerates_brief_fresh(project: Path, monkeypatch):
    """Each resume rewrites the on-disk brief (bake-fresh-on-each-entrypoint)."""
    import planctl.run_worker_resume as m

    monkeypatch.setattr(m, "_read_git_state", lambda: "")
    monkeypatch.setattr(m, "_find_source_commit_sha", lambda task_id: None)

    task_id = _make_task(project)

    r1 = _invoke(["worker", "resume", task_id])
    assert r1.exit_code == 0, r1.output
    brief_first = _brief_path(project, task_id).read_text(encoding="utf-8")

    # Mutate the on-disk brief, then resume again — it must be overwritten fresh.
    _brief_path(project, task_id).write_text("CORRUPT", encoding="utf-8")
    r2 = _invoke(["worker", "resume", task_id])
    assert r2.exit_code == 0, r2.output
    brief_second = _brief_path(project, task_id).read_text(encoding="utf-8")

    assert brief_second != "CORRUPT"
    parsed = json.loads(brief_second)
    assert parsed["task_id"] == task_id
    assert parsed["schema_version"] == 1
    # A valid JSON brief was regenerated (timestamps may differ run-to-run).
    assert json.loads(brief_first)["task_id"] == task_id


def test_worker_resume_no_commit_lands(project: Path, monkeypatch):
    """`worker resume` stays readonly — regenerating the brief lands no commit."""
    import subprocess

    import planctl.run_worker_resume as m

    monkeypatch.setattr(m, "_read_git_state", lambda: "")
    monkeypatch.setattr(m, "_find_source_commit_sha", lambda task_id: None)

    task_id = _make_task(project)

    head_before = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=project,
        capture_output=True,
        text=True,
    ).stdout.strip()

    result = _invoke(["worker", "resume", task_id])
    assert result.exit_code == 0, result.output

    head_after = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=project,
        capture_output=True,
        text=True,
    ).stdout.strip()
    assert head_before == head_after


def test_worker_resume_source_commit_sha_in_nudge(project: Path, monkeypatch):
    """A discovered source commit sha rides the envelope + nudge."""
    import planctl.run_worker_resume as m

    monkeypatch.setattr(m, "_read_git_state", lambda: "")
    monkeypatch.setattr(m, "_find_source_commit_sha", lambda task_id: "abc1234")

    task_id = _make_task(project)
    result = _invoke(["worker", "resume", task_id])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["source_commit_sha"] == "abc1234"
    assert "source_commit=abc1234" in payload["nudge"]


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


def _set_status(project: Path, task_id: str, status: str) -> None:
    """Write runtime state directly — bypasses the normal claim/done flow."""
    state_path = project / ".planctl" / "state" / "tasks" / f"{task_id}.state.json"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(
        json.dumps({"status": status, "updated_at": "2026-04-18T00:00:00Z"}) + "\n",
        encoding="utf-8",
    )


def test_worker_resume_done_task_does_not_flip(project: Path, monkeypatch):
    """`done` task → resume emits envelope without flipping state.

    Under the commit-then-done worker contract, observing `done` here means the
    source commit already shipped (the predecessor reached Phase 6). The resume
    verb just regenerates the brief + emits the nudge; the respawned worker
    decides what to do (typically: verify the trailer commit, call `planctl
    done` idempotently).
    """
    import planctl.run_worker_resume as m

    monkeypatch.setattr(m, "_read_git_state", lambda: "")
    monkeypatch.setattr(m, "_find_source_commit_sha", lambda task_id: None)

    task_id = _make_task(project)
    _set_status(project, task_id, "done")

    result = _invoke(["worker", "resume", task_id])

    assert result.exit_code == 0, result.output
    stderr = result.stderr or ""
    assert "'done'" in stderr  # status warning still surfaces

    state_path = project / ".planctl" / "state" / "tasks" / f"{task_id}.state.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["status"] == "done"

    payload = json.loads(result.output)
    assert payload["status"] == "done"


def test_worker_resume_in_progress_is_noop(project: Path, monkeypatch):
    """Already-in_progress tasks are not mutated by resume."""
    import planctl.run_worker_resume as m

    monkeypatch.setattr(m, "_read_git_state", lambda: "")
    monkeypatch.setattr(m, "_find_source_commit_sha", lambda task_id: None)

    task_id = _make_task(project)
    _set_status(project, task_id, "in_progress")

    before = (
        project / ".planctl" / "state" / "tasks" / f"{task_id}.state.json"
    ).read_text(encoding="utf-8")

    result = _invoke(["worker", "resume", task_id])

    assert result.exit_code == 0, result.output

    after = (
        project / ".planctl" / "state" / "tasks" / f"{task_id}.state.json"
    ).read_text(encoding="utf-8")
    assert before == after


def test_worker_resume_tier_set_rides_envelope(project: Path, monkeypatch):
    """A persisted non-null tier surfaces as a stderr note AND in the envelope."""
    import planctl.run_worker_resume as m

    monkeypatch.setattr(m, "_read_git_state", lambda: "")
    monkeypatch.setattr(m, "_find_source_commit_sha", lambda task_id: None)

    task_id = _make_task(project)
    set_tier = CliRunner().invoke(cli, ["task", "set-tier", task_id, "--tier", "high"])
    assert set_tier.exit_code == 0, set_tier.output

    result = _invoke(["worker", "resume", task_id])

    assert result.exit_code == 0, result.output
    stderr = result.stderr or ""
    assert f"Note: task {task_id} tier is 'high'" in stderr
    payload = json.loads(result.output)
    assert set(payload.keys()) >= {
        "success",
        "task_id",
        "status",
        "tier",
        "brief_ref",
        "nudge",
        "target_repo",
        "primary_repo",
        "worker_agent",
    }
    assert payload["tier"] == "high"
    assert payload["worker_agent"] == "plan:worker-high"


def test_worker_resume_tier_null_emits_raw_note(project: Path, monkeypatch):
    """A null persisted tier surfaces a raw "tier is None" note + explicit JSON null.

    scaffold / refine-apply reject missing tier at mint time. Legacy on-disk
    null-tier records still load; the envelope carries an explicit JSON null so
    the skill consumer can branch on it.
    """
    import planctl.run_worker_resume as m

    monkeypatch.setattr(m, "_read_git_state", lambda: "")
    monkeypatch.setattr(m, "_find_source_commit_sha", lambda task_id: None)

    task_id = _make_task(project)
    task_path = project / ".planctl" / "tasks" / f"{task_id}.json"
    task_def = json.loads(task_path.read_text(encoding="utf-8"))
    task_def["tier"] = None
    task_path.write_text(json.dumps(task_def), encoding="utf-8")
    assert task_def.get("tier") is None

    result = _invoke(["worker", "resume", task_id])

    assert result.exit_code == 0, result.output
    stderr = result.stderr or ""
    assert f"Note: task {task_id} tier is None" in stderr
    assert "cold-resume heuristic" not in stderr
    payload = json.loads(result.output)
    assert "tier" in payload
    assert payload["tier"] is None
    assert payload["worker_agent"] is None


def test_worker_resume_blocked_warns_leaves_alone(project: Path, monkeypatch):
    """`blocked` gets a warn but state is not flipped."""
    import planctl.run_worker_resume as m

    monkeypatch.setattr(m, "_read_git_state", lambda: "")
    monkeypatch.setattr(m, "_find_source_commit_sha", lambda task_id: None)

    task_id = _make_task(project)
    _set_status(project, task_id, "blocked")

    result = _invoke(["worker", "resume", task_id])

    assert result.exit_code == 0, result.output
    stderr = result.stderr or ""
    assert "'blocked'" in stderr

    state_path = project / ".planctl" / "state" / "tasks" / f"{task_id}.state.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["status"] == "blocked"
