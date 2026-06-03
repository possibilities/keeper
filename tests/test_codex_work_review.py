"""Tests for planctl codex work-review command.

fn-614 task .3: session-id env renamed JOBCTL_SESSION_ID → PLANCTL_SESSION_ID.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from click.testing import CliRunner
from planctl.cli import cli

# ---------------------------------------------------------------------------
# Fixture
# ---------------------------------------------------------------------------


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
    runner = CliRunner(mix_stderr=False)
    result = runner.invoke(cli, ["init"])
    assert result.exit_code == 0, result.output
    return tmp_path


def _invoke(args: list[str]):
    return CliRunner(mix_stderr=False).invoke(cli, args)


# ---------------------------------------------------------------------------
# Helpers to build synthetic codex stdout and exec results
# ---------------------------------------------------------------------------


def _make_codex_stdout(verdict: str | None = "SHIP", thread_id: str = "t-abc") -> str:
    events = [
        {"type": "thread.started", "thread_id": thread_id},
        {"type": "message", "content": "Implementation looks solid."},
    ]
    if verdict:
        events.append(
            {
                "type": "message",
                "content": f"Final verdict: <verdict>{verdict}</verdict>",
            }
        )
    return "\n".join(json.dumps(e) for e in events)


def _make_exec_result(
    verdict: str | None = "SHIP", thread_id: str = "t-abc"
) -> tuple[str, str | None, int, str]:
    """Return a (stdout, thread_id, exit_code, stderr) like run_codex_exec."""
    stdout = _make_codex_stdout(verdict=verdict, thread_id=thread_id)
    return stdout, thread_id, 0, ""


# ---------------------------------------------------------------------------
# Helpers to set up epics/tasks and fake git state
# ---------------------------------------------------------------------------


def _create_epic_with_task(project: Path) -> tuple[str, str]:
    """Scaffold a test epic with one task. Return (epic_id, task_id) (fn-565)."""
    from .conftest import seed_epic

    epic_id, task_ids = seed_epic(project, title="Test Epic", n_tasks=1)
    return epic_id, task_ids[0]


def _fake_git_diff(base: str) -> str:
    """Return a minimal fake git diff output."""
    return "diff --git a/foo.py b/foo.py\n--- a/foo.py\n+++ b/foo.py\n@@ -1 +1 @@\n+print('hello')\n"


# ---------------------------------------------------------------------------
# Test: --base explicit path (simplest, no range derivation)
# ---------------------------------------------------------------------------


def test_work_review_explicit_base(project, monkeypatch):
    """--base <sha> path: uses SHA directly, id is optional."""
    monkeypatch.setattr(
        "planctl.codex_review.run_codex_exec",
        MagicMock(return_value=_make_exec_result("SHIP", "t-abc")),
    )
    monkeypatch.setattr(
        "planctl.run_codex_work_review._git_diff",
        MagicMock(return_value=_fake_git_diff("deadbeef")),
    )

    receipt_path = str(project / "receipt.json")
    result = _invoke(
        [
            "codex",
            "work-review",
            "--base",
            "deadbeef",
            "--receipt",
            receipt_path,
        ]
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["success"] is True
    assert payload["verdict"] == "SHIP"
    assert payload["session_id"] == "t-abc"
    assert payload["base"] == "deadbeef"
    assert payload["receipt_path"] == receipt_path


def test_work_review_explicit_base_with_id(project, monkeypatch):
    """--base <sha> with a task id: id used only for labelling."""
    _, task_id = _create_epic_with_task(project)

    monkeypatch.setattr(
        "planctl.codex_review.run_codex_exec",
        MagicMock(return_value=_make_exec_result("NEEDS_WORK", "t-xyz")),
    )
    monkeypatch.setattr(
        "planctl.run_codex_work_review._git_diff",
        MagicMock(return_value=_fake_git_diff("abc123")),
    )

    result = _invoke(
        [
            "codex",
            "work-review",
            task_id,
            "--base",
            "abc123",
        ]
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["verdict"] == "NEEDS_WORK"
    assert payload["base"] == "abc123"
    assert payload["id"] == task_id


# ---------------------------------------------------------------------------
# Test: task id with populated evidence.commits
# ---------------------------------------------------------------------------


def test_work_review_task_with_evidence_commits(project, monkeypatch):
    """Task id with evidence.commits: derives base from earliest commit."""
    epic_id, task_id = _create_epic_with_task(project)

    # Inject runtime state with evidence.commits
    from planctl.project import resolve_project
    from planctl.store import LocalFileStateStore

    ctx = resolve_project()
    store = LocalFileStateStore(ctx.state_dir)
    runtime = {
        "status": "done",
        "claimed_at": "2026-01-01T00:00:00Z",
        "evidence": {"commits": ["sha-early", "sha-later"], "tests": [], "prs": []},
    }
    store.save_runtime(task_id, runtime)

    # _earliest_commit should return sha-early since it's first in git log order
    monkeypatch.setattr(
        "planctl.run_codex_work_review._earliest_commit",
        MagicMock(return_value="sha-early"),
    )
    monkeypatch.setattr(
        "planctl.run_codex_work_review._git_diff",
        MagicMock(return_value=_fake_git_diff("sha-early")),
    )
    monkeypatch.setattr(
        "planctl.codex_review.run_codex_exec",
        MagicMock(return_value=_make_exec_result("SHIP", "t-evidence")),
    )

    result = _invoke(["codex", "work-review", task_id])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["success"] is True
    assert payload["base"] == "sha-early"
    assert payload["verdict"] == "SHIP"


# ---------------------------------------------------------------------------
# Test: task id with empty evidence.commits → claimed_at fallback
# ---------------------------------------------------------------------------


def test_work_review_task_empty_evidence_claimed_at_fallback(project, monkeypatch):
    """Empty evidence.commits falls back to first commit after claimed_at."""
    epic_id, task_id = _create_epic_with_task(project)

    from planctl.project import resolve_project
    from planctl.store import LocalFileStateStore

    ctx = resolve_project()
    store = LocalFileStateStore(ctx.state_dir)
    runtime = {
        "status": "in_progress",
        "claimed_at": "2026-01-01T00:00:00Z",
        "evidence": {"commits": [], "tests": [], "prs": []},
    }
    store.save_runtime(task_id, runtime)

    monkeypatch.setattr(
        "planctl.run_codex_work_review._git_log_first_after",
        MagicMock(return_value="sha-after-claimed"),
    )
    monkeypatch.setattr(
        "planctl.run_codex_work_review._git_diff",
        MagicMock(return_value=_fake_git_diff("sha-after-claimed")),
    )
    monkeypatch.setattr(
        "planctl.codex_review.run_codex_exec",
        MagicMock(return_value=_make_exec_result("SHIP", "t-fallback")),
    )

    result = _invoke(["codex", "work-review", task_id])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["base"] == "sha-after-claimed"


# ---------------------------------------------------------------------------
# Test: epic id with populated evidence across tasks
# ---------------------------------------------------------------------------


def test_work_review_epic_with_evidence(project, monkeypatch):
    """Epic id: unions evidence.commits across tasks, uses earliest."""
    epic_id, task_id = _create_epic_with_task(project)

    # Add a second task via refine-apply (fn-565)
    from .conftest import add_task

    task_id2 = add_task(project, epic_id, title="Task Two")

    from planctl.project import resolve_project
    from planctl.store import LocalFileStateStore

    ctx = resolve_project()
    store = LocalFileStateStore(ctx.state_dir)

    store.save_runtime(
        task_id,
        {
            "status": "done",
            "claimed_at": "2026-01-01T00:00:00Z",
            "evidence": {"commits": ["sha-task1-a"], "tests": [], "prs": []},
        },
    )
    store.save_runtime(
        task_id2,
        {
            "status": "done",
            "claimed_at": "2026-01-02T00:00:00Z",
            "evidence": {"commits": ["sha-task2-a"], "tests": [], "prs": []},
        },
    )

    monkeypatch.setattr(
        "planctl.run_codex_work_review._earliest_commit",
        MagicMock(return_value="sha-task1-a"),
    )
    monkeypatch.setattr(
        "planctl.run_codex_work_review._git_diff",
        MagicMock(return_value=_fake_git_diff("sha-task1-a")),
    )
    monkeypatch.setattr(
        "planctl.codex_review.run_codex_exec",
        MagicMock(return_value=_make_exec_result("SHIP", "t-epic")),
    )

    result = _invoke(["codex", "work-review", epic_id])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["base"] == "sha-task1-a"
    assert payload["id"] == epic_id


# ---------------------------------------------------------------------------
# Test: epic id with zero task evidence → error
# ---------------------------------------------------------------------------


def test_work_review_epic_no_evidence_no_commits_errors(project, monkeypatch):
    """Epic with no evidence and no commits after created_at errors cleanly."""
    epic_id, task_id = _create_epic_with_task(project)

    from planctl.project import resolve_project
    from planctl.store import LocalFileStateStore

    ctx = resolve_project()
    store = LocalFileStateStore(ctx.state_dir)
    store.save_runtime(
        task_id,
        {
            "status": "todo",
            "claimed_at": None,
            "evidence": {"commits": [], "tests": [], "prs": []},
        },
    )

    monkeypatch.setattr(
        "planctl.run_codex_work_review._git_log_first_after",
        MagicMock(return_value=None),
    )

    result = _invoke(["codex", "work-review", epic_id])
    assert result.exit_code != 0
    payload = json.loads(result.output)
    assert payload["success"] is False
    assert "No work has landed yet" in payload["error"]


# ---------------------------------------------------------------------------
# Test: no id and no --base → error
# ---------------------------------------------------------------------------


def test_work_review_no_id_no_base_errors(project):
    """No id and no --base: error with clear message."""
    result = _invoke(["codex", "work-review"])
    assert result.exit_code != 0
    payload = json.loads(result.output)
    assert payload["success"] is False
    assert "--base" in payload["error"]


# ---------------------------------------------------------------------------
# Test: invalid id → error
# ---------------------------------------------------------------------------


def test_work_review_invalid_id_errors(project):
    """Invalid id (not task or epic format) errors cleanly."""
    result = _invoke(["codex", "work-review", "not-a-valid-id"])
    assert result.exit_code != 0
    payload = json.loads(result.output)
    assert payload["success"] is False


# ---------------------------------------------------------------------------
# Test: verdict parsing variants
# ---------------------------------------------------------------------------


def test_work_review_verdict_ship(project, monkeypatch):
    monkeypatch.setattr(
        "planctl.codex_review.run_codex_exec",
        MagicMock(return_value=_make_exec_result("SHIP", "t-s")),
    )
    monkeypatch.setattr(
        "planctl.run_codex_work_review._git_diff",
        MagicMock(return_value=_fake_git_diff("x")),
    )
    result = _invoke(["codex", "work-review", "--base", "somesha"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["verdict"] == "SHIP"


def test_work_review_verdict_needs_work(project, monkeypatch):
    monkeypatch.setattr(
        "planctl.codex_review.run_codex_exec",
        MagicMock(return_value=_make_exec_result("NEEDS_WORK", "t-nw")),
    )
    monkeypatch.setattr(
        "planctl.run_codex_work_review._git_diff",
        MagicMock(return_value=_fake_git_diff("x")),
    )
    result = _invoke(["codex", "work-review", "--base", "somesha"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["verdict"] == "NEEDS_WORK"


def test_work_review_verdict_major_rethink(project, monkeypatch):
    monkeypatch.setattr(
        "planctl.codex_review.run_codex_exec",
        MagicMock(return_value=_make_exec_result("MAJOR_RETHINK", "t-mr")),
    )
    monkeypatch.setattr(
        "planctl.run_codex_work_review._git_diff",
        MagicMock(return_value=_fake_git_diff("x")),
    )
    result = _invoke(["codex", "work-review", "--base", "somesha"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["verdict"] == "MAJOR_RETHINK"


# ---------------------------------------------------------------------------
# Test: receipt round-trip (write on first run, read preamble on second)
# ---------------------------------------------------------------------------


def test_work_review_receipt_roundtrip(project, monkeypatch):
    """First run writes receipt; second run injects rereview preamble."""
    captured_prompts: list[str] = []

    def fake_run_codex_exec(prompt: str, **kwargs) -> tuple[str, str | None, int, str]:
        captured_prompts.append(prompt)
        return _make_exec_result("SHIP", "t-round")

    monkeypatch.setattr("planctl.codex_review.run_codex_exec", fake_run_codex_exec)
    monkeypatch.setattr(
        "planctl.run_codex_work_review._git_diff",
        MagicMock(return_value=_fake_git_diff("base1")),
    )

    receipt_path = str(project / "work-receipt.json")

    # First run: no prior receipt
    result = _invoke(
        [
            "codex",
            "work-review",
            "--base",
            "base1",
            "--receipt",
            receipt_path,
        ]
    )
    assert result.exit_code == 0, result.output
    assert len(captured_prompts) == 1
    assert "RE-REVIEW" not in captured_prompts[0]

    # Verify receipt was written
    receipt = json.loads(Path(receipt_path).read_text())
    assert receipt["type"] == "work_review"
    assert receipt["base"] == "base1"
    assert receipt["verdict"] == "SHIP"
    assert receipt["session_id"] == "t-round"
    assert "timestamp" in receipt

    # Second run: prior receipt present → preamble injected
    result2 = _invoke(
        [
            "codex",
            "work-review",
            "--base",
            "base1",
            "--receipt",
            receipt_path,
        ]
    )
    assert result2.exit_code == 0, result2.output
    assert len(captured_prompts) == 2
    assert "RE-REVIEW" in captured_prompts[1]


# ---------------------------------------------------------------------------
# Test: receipt schema
# ---------------------------------------------------------------------------


def test_work_review_receipt_schema(project, monkeypatch):
    """Receipt JSON has the expected fields."""
    monkeypatch.setattr(
        "planctl.codex_review.run_codex_exec",
        MagicMock(return_value=_make_exec_result("SHIP", "t-schema")),
    )
    monkeypatch.setattr(
        "planctl.run_codex_work_review._git_diff",
        MagicMock(return_value=_fake_git_diff("abcdef")),
    )

    receipt_path = str(project / "schema-receipt.json")
    result = _invoke(
        [
            "codex",
            "work-review",
            "--base",
            "abcdef",
            "--receipt",
            receipt_path,
        ]
    )
    assert result.exit_code == 0, result.output

    receipt = json.loads(Path(receipt_path).read_text())
    assert receipt["type"] == "work_review"
    assert receipt["base"] == "abcdef"
    assert receipt["mode"] == "codex"
    assert receipt["verdict"] == "SHIP"
    assert receipt["session_id"] == "t-schema"
    assert "timestamp" in receipt
    assert "review" in receipt


# ---------------------------------------------------------------------------
# Test: default receipt path
# ---------------------------------------------------------------------------


def test_work_review_default_receipt_path_with_id(project, monkeypatch):
    """Default receipt path includes id when id is provided."""
    _, task_id = _create_epic_with_task(project)

    from planctl.project import resolve_project
    from planctl.store import LocalFileStateStore

    ctx = resolve_project()
    store = LocalFileStateStore(ctx.state_dir)
    store.save_runtime(
        task_id,
        {
            "status": "done",
            "claimed_at": "2026-01-01T00:00:00Z",
            "evidence": {"commits": ["sha-x"], "tests": [], "prs": []},
        },
    )

    monkeypatch.setattr(
        "planctl.run_codex_work_review._earliest_commit",
        MagicMock(return_value="sha-x"),
    )
    monkeypatch.setattr(
        "planctl.run_codex_work_review._git_diff",
        MagicMock(return_value=_fake_git_diff("sha-x")),
    )
    monkeypatch.setattr(
        "planctl.codex_review.run_codex_exec",
        MagicMock(return_value=_make_exec_result("SHIP", "t-dflt")),
    )

    result = _invoke(["codex", "work-review", task_id])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)

    expected = f"/tmp/work-review-receipt-{task_id}.json"
    assert payload["receipt_path"] == expected
    assert Path(expected).exists()


def test_work_review_default_receipt_path_no_id(project, monkeypatch):
    """Default receipt path uses 'branch' suffix when no id given."""
    monkeypatch.setattr(
        "planctl.codex_review.run_codex_exec",
        MagicMock(return_value=_make_exec_result("SHIP", "t-branch")),
    )
    monkeypatch.setattr(
        "planctl.run_codex_work_review._git_diff",
        MagicMock(return_value=_fake_git_diff("sha-b")),
    )

    result = _invoke(["codex", "work-review", "--base", "sha-b"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["receipt_path"] == "/tmp/work-review-receipt-branch.json"
