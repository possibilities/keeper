"""Tests for planctl task ack — the manual approval gate clear verb (fn-386).

Cases:
- Happy path: ack a done task, assert worker_acked_at is set.
- Idempotent re-ack overwrites the timestamp without erroring.
- Ack a non-existent task fails with exit 1.
- Ack a todo task (no worker_done_at) succeeds idempotently.
- Wrong-id-type errors out.
- Envelope contains a planctl_invocation payload with op="task-ack".
"""

from __future__ import annotations

import contextlib
import json
import os
import subprocess

from click.testing import CliRunner
from planctl.cli import cli

_ENV = {**os.environ, "CLAUDE_CODE_SESSION_ID": "test-task-ack-fixture"}


def _create_project(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-task-ack-fixture")
    monkeypatch.chdir(tmp_path)
    # git init so the `claim` verb's `promptctl render-spec` shell-out (which
    # resolves its project root via .git) lands in this project, not a parent.
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    runner = CliRunner()
    result = runner.invoke(cli, ["init"], env=_ENV)
    assert result.exit_code == 0, result.output
    return tmp_path


def _invoke(args: list[str]) -> tuple[int, dict | None, str]:
    runner = CliRunner()
    result = runner.invoke(cli, args, env=_ENV)
    obj = None
    for line in result.output.strip().splitlines():
        line = line.strip()
        if line.startswith("{") and "planctl_invocation" not in line[:30]:
            with contextlib.suppress(json.JSONDecodeError):
                obj = json.loads(line)
            break
    return result.exit_code, obj, result.output


def _read_task(project_path, task_id) -> dict:
    task_path = project_path / ".planctl" / "tasks" / f"{task_id}.json"
    return json.loads(task_path.read_text())


def _write_task(project_path, task_id, data) -> None:
    task_path = project_path / ".planctl" / "tasks" / f"{task_id}.json"
    task_path.write_text(json.dumps(data))


def _make_epic_with_task(tmp_path):
    """Scaffold an epic + task, return (epic_id, task_id) (fn-565)."""
    from .conftest import seed_epic

    epic_id, task_ids = seed_epic(tmp_path, title="Ack epic", n_tasks=1, env=_ENV)
    return epic_id, task_ids[0]


def test_ack_sets_worker_acked_at(tmp_path, monkeypatch):
    """planctl task ack on a done task records worker_acked_at in acks.db.

    fn-488: the stamp moved off the tracked task JSON into the gitignored
    SQLite at ``.planctl/state/acks.db``.  The tracked JSON now carries
    ``worker_done_at`` only; the ack lives in the side store and the
    plug-side bundle builder merges it back at broadcast time.
    """
    from planctl import acks as acks_module

    _create_project(tmp_path, monkeypatch)
    _, task_id = _make_epic_with_task(tmp_path)

    # Mark done first so worker_done_at is stamped.
    # --project bypasses roots discovery (fn-542 task .3): claim is cwd-agnostic
    # and resolves the owning project via roots; pass the path explicitly here.
    _invoke(["claim", task_id, "--force", "--project", str(tmp_path)])
    code, _, _ = _invoke(["done", task_id, "--summary", "ok"])
    assert code == 0
    before = _read_task(tmp_path, task_id)
    assert before.get("worker_done_at") is not None
    # fn-488: tracked JSON never carries the ack field after normalize
    # scrubs it on load — and the verb never re-writes it.
    assert "worker_acked_at" not in before
    assert acks_module.get_task_ack(task_id, repo_root=tmp_path) is None

    code, obj, output = _invoke(["task", "ack", task_id])
    assert code == 0, f"task ack failed:\n{output}"
    assert obj is not None
    assert obj.get("task_id") == task_id
    assert obj.get("worker_acked_at") is not None

    # Tracked JSON still does NOT carry the ack — it lives in acks.db.
    after = _read_task(tmp_path, task_id)
    assert "worker_acked_at" not in after
    assert acks_module.get_task_ack(task_id, repo_root=tmp_path) is not None


def test_ack_is_idempotent_overwrites_timestamp(tmp_path, monkeypatch):
    """Re-acking overwrites the SQLite row with the new now() value."""
    from planctl import acks as acks_module

    _create_project(tmp_path, monkeypatch)
    _, task_id = _make_epic_with_task(tmp_path)
    # --project bypasses roots discovery (fn-542 task .3): claim is cwd-agnostic
    # and resolves the owning project via roots; pass the path explicitly here.
    _invoke(["claim", task_id, "--force", "--project", str(tmp_path)])
    _invoke(["done", task_id, "--summary", "ok"])

    code1, _, _ = _invoke(["task", "ack", task_id])
    assert code1 == 0
    first_ack = acks_module.get_task_ack(task_id, repo_root=tmp_path)
    assert first_ack is not None

    # Force a different timestamp by writing directly to acks.db before re-ack.
    acks_module.save_task_ack(task_id, "2020-01-01T00:00:00Z", repo_root=tmp_path)
    assert (
        acks_module.get_task_ack(task_id, repo_root=tmp_path) == "2020-01-01T00:00:00Z"
    )

    code2, _, _ = _invoke(["task", "ack", task_id])
    assert code2 == 0
    second_ack = acks_module.get_task_ack(task_id, repo_root=tmp_path)
    assert second_ack != "2020-01-01T00:00:00Z"


def test_ack_on_todo_task_succeeds(tmp_path, monkeypatch):
    """Acking a todo task (no worker_done_at) is harmless: stamps acked_at,
    does not error. The gate's grandfathering means an ack without a done is a
    no-op semantically, but the verb itself is unconditional (idempotent)."""
    from planctl import acks as acks_module

    _create_project(tmp_path, monkeypatch)
    _, task_id = _make_epic_with_task(tmp_path)
    before = _read_task(tmp_path, task_id)
    assert before.get("worker_done_at") is None

    code, _, output = _invoke(["task", "ack", task_id])
    assert code == 0, f"task ack on todo task failed:\n{output}"
    after = _read_task(tmp_path, task_id)
    # fn-488: tracked JSON never carries the ack field.
    assert "worker_acked_at" not in after
    # done_at was never stamped — gate is grandfathered (returns False).
    assert after.get("worker_done_at") is None
    # ack landed in the SQLite side store regardless.
    assert acks_module.get_task_ack(task_id, repo_root=tmp_path) is not None


def test_ack_nonexistent_task_errors(tmp_path, monkeypatch):
    """planctl task ack fn-9999.1 fails non-zero with a 'not found' message."""
    _create_project(tmp_path, monkeypatch)
    code, _, output = _invoke(["task", "ack", "fn-9999-no-task.1"])
    assert code != 0
    assert "not found" in output.lower() or "fn-9999" in output


def test_ack_invalid_id_type_errors(tmp_path, monkeypatch):
    """Acking an epic id via task ack fails-visibly (not a task id)."""
    _create_project(tmp_path, monkeypatch)
    epic_id, _ = _make_epic_with_task(tmp_path)
    # epic_id is not a valid task id (no .N suffix).
    code, _, output = _invoke(["task", "ack", epic_id])
    assert code != 0
    assert "invalid" in output.lower()


def test_ack_envelope_carries_planctl_invocation(tmp_path, monkeypatch):
    """The CLI envelope includes a planctl_invocation payload with op=task-ack."""
    _create_project(tmp_path, monkeypatch)
    _, task_id = _make_epic_with_task(tmp_path)
    runner = CliRunner()
    result = runner.invoke(cli, ["task", "ack", task_id], env=_ENV)
    assert result.exit_code == 0
    # Mutating verbs emit compact NDJSON — single line with planctl_invocation.
    assert '"planctl_invocation"' in result.output
    payload = json.loads(result.output.strip().splitlines()[-1])
    inv = payload.get("planctl_invocation") or {}
    assert inv.get("op") == "task-ack"
    assert inv.get("target") == task_id
