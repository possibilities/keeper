"""Subprocess wiring tests for plugin/hooks/subagent-stop-guard.ts.

These drive the real bun dispatcher with fixture stdin against a temp HOME so
the SubagentStop block/allow ladder is exercised end-to-end. A stub ``planctl``
on PATH (a bun shim echoing a canned reconcile envelope and touching a sentinel)
covers both the verdict handling and the marker-vs-transcript task-id resolution.

Slow bucket (``integration``): each test spawns bun + a child planctl shim.
Skips when bun is absent.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
GUARD = REPO_ROOT / "plugin" / "hooks" / "subagent-stop-guard.ts"

SESSION = "sess-subagent-pytest"

pytestmark = pytest.mark.integration


@pytest.fixture
def home(tmp_path: Path) -> Path:
    """A temp HOME with the session-marker dir + a bin dir pre-created."""
    (tmp_path / ".local" / "state" / "planctl" / "sessions").mkdir(parents=True)
    (tmp_path / "bin").mkdir()
    return tmp_path


def _sessions_dir(home: Path) -> Path:
    return home / ".local" / "state" / "planctl" / "sessions"


def _write_work_marker(home: Path, task_id: str) -> Path:
    path = _sessions_dir(home) / f"{SESSION}.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "session_id": SESSION,
                "kind": "work",
                "task_id": task_id,
                "created_at": "2026-06-11T00:00:00Z",
            }
        ),
        encoding="utf-8",
    )
    return path


def _write_transcript(home: Path, task_id: str) -> Path:
    """Drop a one-line JSONL transcript whose first user message carries the
    spawn prompt's ``TASK_ID:`` line."""
    path = home / "transcript.jsonl"
    path.write_text(
        json.dumps(
            {
                "type": "user",
                "message": {
                    "role": "user",
                    "content": f"Resume a planctl task.\n\nTASK_ID: {task_id}\n",
                },
            }
        ),
        encoding="utf-8",
    )
    return path


def _write_planctl_shim(home: Path, envelope: dict, *, exit_code: int = 0) -> Path:
    """Drop a bun ``planctl`` shim echoing ``envelope`` and touching a sentinel.

    Returns the sentinel path so a test can assert whether planctl was called.
    """
    sentinel = home / "planctl-called"
    shim = home / "bin" / "planctl"
    shim.write_text(
        "#!/usr/bin/env bun\n"
        'import { writeFileSync } from "node:fs";\n'
        f'writeFileSync({json.dumps(str(sentinel))}, "1");\n'
        f"process.stdout.write({json.dumps(json.dumps(envelope) + chr(10))});\n"
        f"process.exit({exit_code});\n",
        encoding="utf-8",
    )
    shim.chmod(0o755)
    return sentinel


def _run_guard(
    home: Path, payload: dict, **extra_env: str
) -> subprocess.CompletedProcess:
    bun = shutil.which("bun")
    assert bun is not None
    env = {
        **os.environ,
        "HOME": str(home),
        "PATH": f"{home / 'bin'}:{os.environ.get('PATH', '')}",
        **extra_env,
    }
    return subprocess.run(
        [bun, str(GUARD)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=30,
        env=env,
    )


def _stop_payload(**overrides) -> dict:
    payload = {
        "hook_event_name": "SubagentStop",
        "session_id": SESSION,
        "agent_id": "agent-7",
        "agent_type": "plan:worker-medium",
        "stop_hook_active": False,
    }
    payload.update(overrides)
    return payload


@pytest.fixture(autouse=True)
def require_bun() -> None:
    if shutil.which("bun") is None:
        pytest.skip("bun not on PATH")


def test_in_progress_uncommitted_blocks(home: Path) -> None:
    """A worker stopping in_progress_uncommitted → top-level block carrying the
    matching Phase 2b nudge naming the task id."""
    _write_work_marker(home, "fn-1-x.2")
    _write_planctl_shim(
        home, {"verdict": "in_progress_uncommitted", "task_id": "fn-1-x.2"}
    )

    result = _run_guard(home, _stop_payload())
    assert result.returncode == 0, result.stderr
    env = json.loads(result.stdout)
    assert env["decision"] == "block"
    assert "fn-1-x.2" in env["reason"]
    assert "keeper commit-work" in env["reason"]


def test_blocked_message_allows(home: Path) -> None:
    """A `BLOCKED:` last_assistant_message allows before any planctl call."""
    _write_work_marker(home, "fn-1-x.2")
    sentinel = _write_planctl_shim(
        home, {"verdict": "in_progress_uncommitted", "task_id": "fn-1-x.2"}
    )

    result = _run_guard(
        home, _stop_payload(last_assistant_message="BLOCKED: TOOLING_FAILURE\nTask: x")
    )
    assert result.returncode == 0
    assert result.stdout == ""
    assert not sentinel.exists()


def test_stop_hook_active_allows(home: Path) -> None:
    """stop_hook_active true short-circuits before any planctl call (block-once)."""
    _write_work_marker(home, "fn-1-x.2")
    sentinel = _write_planctl_shim(
        home, {"verdict": "in_progress_uncommitted", "task_id": "fn-1-x.2"}
    )

    result = _run_guard(home, _stop_payload(stop_hook_active=True))
    assert result.returncode == 0
    assert result.stdout == ""
    assert not sentinel.exists()


def test_tooling_error_fails_open(home: Path) -> None:
    """tooling_error verdict → allow (fail open)."""
    _write_work_marker(home, "fn-1-x.2")
    _write_planctl_shim(home, {"verdict": "tooling_error", "task_id": "fn-1-x.2"})

    result = _run_guard(home, _stop_payload())
    assert result.returncode == 0
    assert result.stdout == ""


def test_done_allows_and_unlinks(home: Path) -> None:
    """A done verdict allows AND unlinks the stale marker."""
    marker = _write_work_marker(home, "fn-1-x.2")
    _write_planctl_shim(home, {"verdict": "done", "task_id": "fn-1-x.2"})

    result = _run_guard(home, _stop_payload())
    assert result.returncode == 0
    assert result.stdout == ""
    assert not marker.exists()


def test_marker_fallback_to_transcript(home: Path) -> None:
    """With no marker, the task id resolves from the transcript spawn prompt and
    the guard blocks naming that id."""
    transcript = _write_transcript(home, "fn-3-z.1")
    _write_planctl_shim(
        home, {"verdict": "in_progress_uncommitted", "task_id": "fn-3-z.1"}
    )

    result = _run_guard(home, _stop_payload(agent_transcript_path=str(transcript)))
    assert result.returncode == 0, result.stderr
    env = json.loads(result.stdout)
    assert env["decision"] == "block"
    assert "fn-3-z.1" in env["reason"]


def test_no_task_id_allows(home: Path) -> None:
    """No marker and no resolvable transcript id → allow, zero planctl calls."""
    sentinel = _write_planctl_shim(
        home, {"verdict": "in_progress_uncommitted", "task_id": "fn-1-x.2"}
    )

    result = _run_guard(home, _stop_payload())
    assert result.returncode == 0
    assert result.stdout == ""
    assert not sentinel.exists()


def test_bypass_allows_before_io(home: Path) -> None:
    """PLANCTL_GUARD_BYPASS=1 short-circuits before any planctl call."""
    _write_work_marker(home, "fn-1-x.2")
    sentinel = _write_planctl_shim(
        home, {"verdict": "in_progress_uncommitted", "task_id": "fn-1-x.2"}
    )

    result = _run_guard(home, _stop_payload(), PLANCTL_GUARD_BYPASS="1")
    assert result.returncode == 0
    assert result.stdout == ""
    assert not sentinel.exists()
