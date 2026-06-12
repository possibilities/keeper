"""Subprocess wiring tests for plugin/hooks/stop-guard.ts.

These drive the real bun dispatcher with fixture stdin against a temp HOME so
the Stop block/allow ladder is exercised end-to-end. A stub ``planctl`` on PATH
(a bun shim echoing a canned reconcile envelope and touching a sentinel) covers
the work-branch verdict handling; the no-marker hot path and the close branch
assert zero planctl invocations via the sentinel.

Slow bucket (``integration``): each test spawns bun (and, on the work branch, a
child planctl shim). Skips when bun is absent.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
GUARD = REPO_ROOT / "plugin" / "hooks" / "stop-guard.ts"

SESSION = "sess-stop-pytest"

pytestmark = pytest.mark.integration


@pytest.fixture
def home(tmp_path: Path) -> Path:
    """A temp HOME with the session-marker dir + a bin dir pre-created."""
    (tmp_path / ".local" / "state" / "planctl" / "sessions").mkdir(parents=True)
    (tmp_path / "bin").mkdir()
    return tmp_path


def _sessions_dir(home: Path) -> Path:
    return home / ".local" / "state" / "planctl" / "sessions"


def _marker_path(home: Path) -> Path:
    return _sessions_dir(home) / f"{SESSION}.json"


def _write_work_marker(home: Path, task_id: str) -> Path:
    path = _marker_path(home)
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


def _write_close_marker(home: Path, epic_id: str) -> Path:
    path = _marker_path(home)
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "session_id": SESSION,
                "kind": "close",
                "epic_id": epic_id,
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
        [bun, str(GUARD)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=30,
        env=env,
    )


def _stop_payload(**overrides) -> dict:
    payload = {
        "hook_event_name": "Stop",
        "session_id": SESSION,
        "stop_hook_active": False,
    }
    payload.update(overrides)
    return payload


@pytest.fixture(autouse=True)
def require_bun() -> None:
    if shutil.which("bun") is None:
        pytest.skip("bun not on PATH")


def test_no_marker_fast_allow_no_subprocess(home: Path) -> None:
    """The common hot path: no marker → exit 0, empty stdout, zero planctl
    invocations (no reconcile spawn)."""
    sentinel = _write_planctl_shim(home, {"verdict": "in_progress_uncommitted"})

    result = _run_guard(home, _stop_payload())
    assert result.returncode == 0, result.stderr
    assert result.stdout == ""
    assert not sentinel.exists()


def test_work_block_then_second_stop_allows(home: Path) -> None:
    """A work marker + non-done verdict blocks once with the resume checklist;
    a second stop with stop_hook_active passes through (block-once)."""
    _write_work_marker(home, "fn-1-x.2")
    _write_planctl_shim(home, {"verdict": "in_progress_uncommitted"})

    first = _run_guard(home, _stop_payload())
    assert first.returncode == 0, first.stderr
    env = json.loads(first.stdout)
    assert env["decision"] == "block"
    assert "fn-1-x.2" in env["reason"]
    assert "planctl worker resume fn-1-x.2" in env["reason"]

    second = _run_guard(home, _stop_payload(stop_hook_active=True))
    assert second.returncode == 0
    assert second.stdout == ""


def test_done_verdict_allows_and_clears_marker(home: Path) -> None:
    """A done verdict allows AND unlinks the stale work marker."""
    marker = _write_work_marker(home, "fn-1-x.2")
    _write_planctl_shim(home, {"verdict": "done"})

    result = _run_guard(home, _stop_payload())
    assert result.returncode == 0
    assert result.stdout == ""
    assert not marker.exists()


def test_work_tooling_error_fails_open(home: Path) -> None:
    """tooling_error verdict → allow (fail open)."""
    _write_work_marker(home, "fn-1-x.2")
    _write_planctl_shim(home, {"verdict": "tooling_error"})

    result = _run_guard(home, _stop_payload())
    assert result.returncode == 0
    assert result.stdout == ""


def test_close_block_on_bare_mid_saga_stop(home: Path) -> None:
    """A close marker + a bare (non-typed) last message blocks with the mid-saga
    reason, and never spawns reconcile (message-only decision)."""
    _write_close_marker(home, "fn-1-x")
    sentinel = _write_planctl_shim(home, {"verdict": "ignored"})

    result = _run_guard(
        home, _stop_payload(last_assistant_message="Audit done, agents returned.")
    )
    assert result.returncode == 0, result.stderr
    env = json.loads(result.stdout)
    assert env["decision"] == "block"
    assert "fn-1-x" in env["reason"]
    assert "mid-saga" in env["reason"]
    assert not sentinel.exists()


@pytest.mark.parametrize(
    "message",
    [
        "BLOCKED: TOOLING_FAILURE — auditor unreachable after 5 attempts",
        "QUESTION: should the schema version bump major?",
        'Surfacing: {"success": false, "error": {"code": "STALE_ARTIFACTS"}}',
        "Halted `fn-1-x`. fatal finding: data loss. epic NOT closed.",
        "Partial follow-up for `fn-1-x` (expected 3 tasks, found 1).",
    ],
)
def test_close_allows_on_typed_stop_surfaces(home: Path, message: str) -> None:
    """Every sanctioned close stop surface (BLOCKED / QUESTION / typed error /
    fatal-halt / partial-followup) passes through the lenient close branch."""
    _write_close_marker(home, "fn-1-x")

    result = _run_guard(home, _stop_payload(last_assistant_message=message))
    assert result.returncode == 0, result.stderr
    assert result.stdout == ""


def test_bypass_allows_before_io(home: Path) -> None:
    """PLANCTL_GUARD_BYPASS=1 short-circuits before any marker read or planctl
    call."""
    _write_work_marker(home, "fn-1-x.2")
    sentinel = _write_planctl_shim(home, {"verdict": "in_progress_uncommitted"})

    result = _run_guard(home, _stop_payload(), PLANCTL_GUARD_BYPASS="1")
    assert result.returncode == 0
    assert result.stdout == ""
    assert not sentinel.exists()
