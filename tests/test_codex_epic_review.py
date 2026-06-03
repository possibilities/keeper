"""Tests for planctl codex epic-review command.

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
        {"type": "message", "content": "Spec compliance looks solid."},
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
# Test: task id input → error (epic-review is epic-only)
# ---------------------------------------------------------------------------


def test_epic_review_rejects_task_id(project):
    """Task id input errors with the expected message."""
    _, task_id = _create_epic_with_task(project)

    result = _invoke(["codex", "epic-review", task_id])
    assert result.exit_code != 0
    payload = json.loads(result.output)
    assert payload["success"] is False
    assert "epic-review operates on epics only" in payload["error"]
    assert "review-work" in payload["error"]


# ---------------------------------------------------------------------------
# Test: invalid id → error
# ---------------------------------------------------------------------------


def test_epic_review_invalid_id_errors(project):
    """Invalid id (not epic format) errors cleanly."""
    result = _invoke(["codex", "epic-review", "not-a-valid-id"])
    assert result.exit_code != 0
    payload = json.loads(result.output)
    assert payload["success"] is False


# ---------------------------------------------------------------------------
# Test: --base explicit path
# ---------------------------------------------------------------------------


def test_epic_review_explicit_base(project, monkeypatch):
    """--base <sha> path: uses SHA directly."""
    epic_id, _ = _create_epic_with_task(project)

    monkeypatch.setattr(
        "planctl.codex_review.run_codex_exec",
        MagicMock(return_value=_make_exec_result("SHIP", "t-abc")),
    )
    monkeypatch.setattr(
        "planctl.run_codex_epic_review._git_diff",
        MagicMock(return_value=_fake_git_diff("deadbeef")),
    )

    receipt_path = str(project / "receipt.json")
    result = _invoke(
        [
            "codex",
            "epic-review",
            epic_id,
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
    assert payload["type"] == "epic_review"
    assert payload["id"] == epic_id


# ---------------------------------------------------------------------------
# Test: SHIP verdict happy path
# ---------------------------------------------------------------------------


def test_epic_review_verdict_ship(project, monkeypatch):
    epic_id, _ = _create_epic_with_task(project)

    monkeypatch.setattr(
        "planctl.codex_review.run_codex_exec",
        MagicMock(return_value=_make_exec_result("SHIP", "t-s")),
    )
    monkeypatch.setattr(
        "planctl.run_codex_epic_review._git_diff",
        MagicMock(return_value=_fake_git_diff("x")),
    )
    result = _invoke(["codex", "epic-review", epic_id, "--base", "somesha"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["verdict"] == "SHIP"


# ---------------------------------------------------------------------------
# Test: NEEDS_WORK verdict
# ---------------------------------------------------------------------------


def test_epic_review_verdict_needs_work(project, monkeypatch):
    epic_id, _ = _create_epic_with_task(project)

    monkeypatch.setattr(
        "planctl.codex_review.run_codex_exec",
        MagicMock(return_value=_make_exec_result("NEEDS_WORK", "t-nw")),
    )
    monkeypatch.setattr(
        "planctl.run_codex_epic_review._git_diff",
        MagicMock(return_value=_fake_git_diff("x")),
    )
    result = _invoke(["codex", "epic-review", epic_id, "--base", "somesha"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["verdict"] == "NEEDS_WORK"
    assert payload["session_id"] == "t-nw"


# ---------------------------------------------------------------------------
# Test: receipt round-trip (write on first run, read preamble on second)
# ---------------------------------------------------------------------------


def test_epic_review_receipt_roundtrip(project, monkeypatch):
    """First run writes receipt; second run injects rereview preamble."""
    epic_id, _ = _create_epic_with_task(project)
    captured_prompts: list[str] = []

    def fake_run_codex_exec(prompt: str, **kwargs) -> tuple[str, str | None, int, str]:
        captured_prompts.append(prompt)
        return _make_exec_result("SHIP", "t-round")

    monkeypatch.setattr("planctl.codex_review.run_codex_exec", fake_run_codex_exec)
    monkeypatch.setattr(
        "planctl.run_codex_epic_review._git_diff",
        MagicMock(return_value=_fake_git_diff("base1")),
    )

    receipt_path = str(project / "epic-receipt.json")

    # First run: no prior receipt
    result = _invoke(
        [
            "codex",
            "epic-review",
            epic_id,
            "--base",
            "base1",
            "--receipt",
            receipt_path,
        ]
    )
    assert result.exit_code == 0, result.output
    assert len(captured_prompts) == 1
    assert "RE-REVIEW" not in captured_prompts[0]

    # Verify receipt was written with expected fields
    receipt = json.loads(Path(receipt_path).read_text())
    assert receipt["type"] == "epic_review"
    assert receipt["id"] == epic_id
    assert receipt["base"] == "base1"
    assert receipt["verdict"] == "SHIP"
    assert receipt["session_id"] == "t-round"
    assert "timestamp" in receipt

    # Second run: prior receipt present → preamble injected
    result2 = _invoke(
        [
            "codex",
            "epic-review",
            epic_id,
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


def test_epic_review_receipt_schema(project, monkeypatch):
    """Receipt JSON has the expected fields."""
    epic_id, _ = _create_epic_with_task(project)

    monkeypatch.setattr(
        "planctl.codex_review.run_codex_exec",
        MagicMock(return_value=_make_exec_result("SHIP", "t-schema")),
    )
    monkeypatch.setattr(
        "planctl.run_codex_epic_review._git_diff",
        MagicMock(return_value=_fake_git_diff("abcdef")),
    )

    receipt_path = str(project / "schema-receipt.json")
    result = _invoke(
        [
            "codex",
            "epic-review",
            epic_id,
            "--base",
            "abcdef",
            "--receipt",
            receipt_path,
        ]
    )
    assert result.exit_code == 0, result.output

    receipt = json.loads(Path(receipt_path).read_text())
    assert receipt["type"] == "epic_review"
    assert receipt["id"] == epic_id
    assert receipt["base"] == "abcdef"
    assert receipt["mode"] == "codex"
    assert receipt["verdict"] == "SHIP"
    assert receipt["session_id"] == "t-schema"
    assert "timestamp" in receipt
    assert "review" in receipt


# ---------------------------------------------------------------------------
# Test: default receipt path
# ---------------------------------------------------------------------------


def test_epic_review_default_receipt_path(project, monkeypatch):
    """Default receipt path includes epic_id."""
    epic_id, task_id = _create_epic_with_task(project)

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
        "planctl.run_codex_epic_review._earliest_commit",
        MagicMock(return_value="sha-x"),
    )
    monkeypatch.setattr(
        "planctl.run_codex_epic_review._git_diff",
        MagicMock(return_value=_fake_git_diff("sha-x")),
    )
    monkeypatch.setattr(
        "planctl.codex_review.run_codex_exec",
        MagicMock(return_value=_make_exec_result("SHIP", "t-dflt")),
    )

    result = _invoke(["codex", "epic-review", epic_id])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)

    expected = f"/tmp/epic-review-receipt-{epic_id}.json"
    assert payload["receipt_path"] == expected
    assert Path(expected).exists()


# ---------------------------------------------------------------------------
# Test: epic with populated evidence.commits across tasks → base derivation
# ---------------------------------------------------------------------------


def test_epic_review_base_derivation_from_evidence(project, monkeypatch):
    """Epic id: unions evidence.commits across tasks, uses earliest."""
    epic_id, task_id = _create_epic_with_task(project)

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
        "planctl.run_codex_epic_review._earliest_commit",
        MagicMock(return_value="sha-task1-a"),
    )
    monkeypatch.setattr(
        "planctl.run_codex_epic_review._git_diff",
        MagicMock(return_value=_fake_git_diff("sha-task1-a")),
    )
    monkeypatch.setattr(
        "planctl.codex_review.run_codex_exec",
        MagicMock(return_value=_make_exec_result("SHIP", "t-epic")),
    )

    result = _invoke(["codex", "epic-review", epic_id])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["base"] == "sha-task1-a"
    assert payload["id"] == epic_id


# ---------------------------------------------------------------------------
# Test: epic with no evidence → falls back to created_at
# ---------------------------------------------------------------------------


def test_epic_review_base_derivation_fallback_to_created_at(project, monkeypatch):
    """No evidence.commits falls back to first commit after epic.created_at."""
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
        "planctl.run_codex_epic_review._git_log_first_after",
        MagicMock(return_value="sha-after-created"),
    )
    monkeypatch.setattr(
        "planctl.run_codex_epic_review._git_diff",
        MagicMock(return_value=_fake_git_diff("sha-after-created")),
    )
    monkeypatch.setattr(
        "planctl.codex_review.run_codex_exec",
        MagicMock(return_value=_make_exec_result("SHIP", "t-fallback")),
    )

    result = _invoke(["codex", "epic-review", epic_id])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["base"] == "sha-after-created"


# ---------------------------------------------------------------------------
# Test: epic with no evidence and no commits after created_at → error
# ---------------------------------------------------------------------------


def test_epic_review_no_evidence_no_commits_errors(project, monkeypatch):
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
        "planctl.run_codex_epic_review._git_log_first_after",
        MagicMock(return_value=None),
    )

    result = _invoke(["codex", "epic-review", epic_id])
    assert result.exit_code != 0
    payload = json.loads(result.output)
    assert payload["success"] is False
    assert "No work has landed yet" in payload["error"]


# ---------------------------------------------------------------------------
# Test: prompt contains three-phase structure
# ---------------------------------------------------------------------------


def test_epic_review_prompt_has_three_phases(project, monkeypatch):
    """Prompt includes all three phase headings."""
    epic_id, _ = _create_epic_with_task(project)
    captured_prompts: list[str] = []

    def fake_run_codex_exec(prompt: str, **kwargs) -> tuple[str, str | None, int, str]:
        captured_prompts.append(prompt)
        return _make_exec_result("SHIP", "t-phases")

    monkeypatch.setattr("planctl.codex_review.run_codex_exec", fake_run_codex_exec)
    monkeypatch.setattr(
        "planctl.run_codex_epic_review._git_diff",
        MagicMock(return_value=_fake_git_diff("base1")),
    )

    _invoke(["codex", "epic-review", epic_id, "--base", "base1"])

    assert len(captured_prompts) == 1
    prompt = captured_prompts[0]
    assert "Phase 1" in prompt
    assert "Extract Requirements" in prompt
    assert "Phase 2" in prompt
    assert "Forward Coverage" in prompt
    assert "Phase 3" in prompt
    assert "Reverse Coverage" in prompt
    assert "<verdict>SHIP</verdict>" in prompt
    assert "<verdict>NEEDS_WORK</verdict>" in prompt
