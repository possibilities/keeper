"""Subprocess wiring tests for plugin/hooks/commit-guard.ts.

These drive the real bun dispatcher with fixture stdin against a temp HOME so
the on-disk marker contract and the reconcile deny/allow ladder are exercised
end-to-end. A stub ``planctl`` on PATH (a bun shim that echoes a canned
reconcile envelope and touches a sentinel) lets us assert both the verdict
handling and that the short-circuits make zero planctl subprocesses.

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
COMMIT_GUARD = REPO_ROOT / "plugin" / "hooks" / "commit-guard.ts"

SESSION = "sess-commit-pytest"

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
        [bun, str(COMMIT_GUARD)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=30,
        env=env,
    )


def _bash_payload(**overrides) -> dict:
    payload = {
        "hook_event_name": "PreToolUse",
        "session_id": SESSION,
        "tool_name": "Bash",
        "tool_input": {"command": "git commit -m y"},
    }
    payload.update(overrides)
    return payload


@pytest.fixture(autouse=True)
def _require_bun() -> None:
    if shutil.which("bun") is None:
        pytest.skip("bun not on PATH")


def test_main_context_in_progress_denies(home: Path) -> None:
    """Main-context `git commit` with an in_progress reconcile → deny naming
    the task id."""
    _write_work_marker(home, "fn-1-x.2")
    _write_planctl_shim(
        home, {"verdict": "in_progress_uncommitted", "task_id": "fn-1-x.2"}
    )

    result = _run_guard(home, _bash_payload())
    assert result.returncode == 0, result.stderr
    env = json.loads(result.stdout)
    spec = env["hookSpecificOutput"]
    assert spec["hookEventName"] == "PreToolUse"
    assert spec["permissionDecision"] == "deny"
    assert "fn-1-x.2" in spec["permissionDecisionReason"]


def test_compound_command_denies(home: Path) -> None:
    """`cd x && git commit` is caught by the command-boundary regex."""
    _write_work_marker(home, "fn-1-x.2")
    _write_planctl_shim(
        home, {"verdict": "in_progress_committed", "task_id": "fn-1-x.2"}
    )

    result = _run_guard(
        home, _bash_payload(tool_input={"command": "cd sub && git commit -m y"})
    )
    assert result.returncode == 0, result.stderr
    assert (
        json.loads(result.stdout)["hookSpecificOutput"]["permissionDecision"] == "deny"
    )


def test_worker_context_passes(home: Path) -> None:
    """agent_id present → always allow, no planctl call."""
    _write_work_marker(home, "fn-1-x.2")
    sentinel = _write_planctl_shim(
        home, {"verdict": "in_progress_uncommitted", "task_id": "fn-1-x.2"}
    )

    result = _run_guard(home, _bash_payload(agent_id="agent-7"))
    assert result.returncode == 0
    assert result.stdout == ""
    assert not sentinel.exists()


def test_done_reconcile_allows_and_unlinks(home: Path) -> None:
    """A done verdict allows AND unlinks the stale marker."""
    marker = _write_work_marker(home, "fn-1-x.2")
    _write_planctl_shim(home, {"verdict": "done", "task_id": "fn-1-x.2"})

    result = _run_guard(home, _bash_payload())
    assert result.returncode == 0
    assert result.stdout == ""
    assert not marker.exists()


def test_tooling_error_fails_open_keeps_marker(home: Path) -> None:
    """tooling_error verdict → allow (fail open), marker preserved."""
    marker = _write_work_marker(home, "fn-1-x.2")
    _write_planctl_shim(home, {"verdict": "tooling_error", "task_id": "fn-1-x.2"})

    result = _run_guard(home, _bash_payload())
    assert result.returncode == 0
    assert result.stdout == ""
    assert marker.exists()


def test_non_commit_bash_skips_planctl(home: Path) -> None:
    """A non-commit Bash command makes zero planctl subprocesses."""
    _write_work_marker(home, "fn-1-x.2")
    sentinel = _write_planctl_shim(
        home, {"verdict": "in_progress_uncommitted", "task_id": "fn-1-x.2"}
    )

    result = _run_guard(home, _bash_payload(tool_input={"command": "git status"}))
    assert result.returncode == 0
    assert result.stdout == ""
    assert not sentinel.exists()


def test_bypass_allows_before_io(home: Path) -> None:
    """PLANCTL_GUARD_BYPASS=1 short-circuits before any planctl call."""
    _write_work_marker(home, "fn-1-x.2")
    sentinel = _write_planctl_shim(
        home, {"verdict": "in_progress_uncommitted", "task_id": "fn-1-x.2"}
    )

    result = _run_guard(home, _bash_payload(), PLANCTL_GUARD_BYPASS="1")
    assert result.returncode == 0
    assert result.stdout == ""
    assert not sentinel.exists()
