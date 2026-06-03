"""Tests for planctl epic ack — the manual approval gate clear verb (fn-386).

fn-614 task .3: session-id env renamed JOBCTL_SESSION_ID → PLANCTL_SESSION_ID.

Cases:
- Happy path: ack a closed epic, assert closer_acked_at is set.
- Idempotent re-ack overwrites the timestamp without erroring.
- Ack a non-existent epic fails with exit 1.
- Ack a wrong-id-type errors out.
- Envelope contains a planctl_invocation payload with op="epic-ack".
"""

from __future__ import annotations

import contextlib
import json
import os

from click.testing import CliRunner
from planctl.cli import cli

_ENV = {**os.environ, "PLANCTL_SESSION_ID": "test-epic-ack-fixture"}


def _create_project(tmp_path, monkeypatch):
    """Init a planctl project under a fresh git repo (fn-589 task .1, item 2)."""
    import subprocess

    monkeypatch.setenv("PLANCTL_SESSION_ID", "test-epic-ack-fixture")
    monkeypatch.chdir(tmp_path)
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


def _read_epic(project_path, epic_id) -> dict:
    epic_path = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    return json.loads(epic_path.read_text())


def _write_epic(project_path, epic_id, data) -> None:
    epic_path = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    epic_path.write_text(json.dumps(data))


def _make_closed_epic(tmp_path) -> str:
    """Create + close an epic, return epic_id with closer_done_at stamped."""
    code, obj, output = _invoke(["epic", "create", "--title", "Ack epic"])
    assert code == 0, output
    epic_id = obj["epic"]["id"]
    code, _, output = _invoke(["epic", "close", epic_id, "--force"])
    assert code == 0, output
    return epic_id


def test_ack_sets_closer_acked_at(tmp_path, monkeypatch):
    """planctl epic ack on a closed epic records closer_acked_at in acks.db.

    fn-488: the stamp moved off the tracked epic JSON into the gitignored
    SQLite at ``.planctl/state/acks.db``.  The tracked JSON now carries
    ``closer_done_at`` only; the ack lives in the side store and the
    plug-side bundle builder merges it back at broadcast time.
    """
    from planctl import acks as acks_module

    _create_project(tmp_path, monkeypatch)
    epic_id = _make_closed_epic(tmp_path)

    before = _read_epic(tmp_path, epic_id)
    assert before.get("closer_done_at") is not None
    # fn-488: tracked JSON never carries the ack field after normalize
    # scrubs it on load — and the verb never re-writes it.
    assert "closer_acked_at" not in before
    assert acks_module.get_epic_ack(epic_id, repo_root=tmp_path) is None

    code, obj, output = _invoke(["epic", "ack", epic_id])
    assert code == 0, f"epic ack failed:\n{output}"
    assert obj is not None
    assert obj.get("epic_id") == epic_id
    assert obj.get("closer_acked_at") is not None

    after = _read_epic(tmp_path, epic_id)
    assert "closer_acked_at" not in after
    assert acks_module.get_epic_ack(epic_id, repo_root=tmp_path) is not None


def test_ack_is_idempotent_overwrites_timestamp(tmp_path, monkeypatch):
    """Re-acking overwrites the SQLite row with the new now() value."""
    from planctl import acks as acks_module

    _create_project(tmp_path, monkeypatch)
    epic_id = _make_closed_epic(tmp_path)

    code1, _, _ = _invoke(["epic", "ack", epic_id])
    assert code1 == 0
    first_ack = acks_module.get_epic_ack(epic_id, repo_root=tmp_path)
    assert first_ack is not None

    # Force a different timestamp by writing directly to acks.db before re-ack.
    acks_module.save_epic_ack(epic_id, "2020-01-01T00:00:00Z", repo_root=tmp_path)
    assert (
        acks_module.get_epic_ack(epic_id, repo_root=tmp_path) == "2020-01-01T00:00:00Z"
    )

    code2, _, _ = _invoke(["epic", "ack", epic_id])
    assert code2 == 0
    second_ack = acks_module.get_epic_ack(epic_id, repo_root=tmp_path)
    assert second_ack != "2020-01-01T00:00:00Z"


def test_ack_on_open_epic_succeeds(tmp_path, monkeypatch):
    """Acking an open epic (no closer_done_at) is harmless: stamps acked_at,
    does not error. The gate's grandfathering keeps it a no-op semantically."""
    from planctl import acks as acks_module

    _create_project(tmp_path, monkeypatch)
    code, obj, _ = _invoke(["epic", "create", "--title", "Open epic"])
    assert code == 0
    epic_id = obj["epic"]["id"]
    before = _read_epic(tmp_path, epic_id)
    assert before.get("closer_done_at") is None

    code, _, output = _invoke(["epic", "ack", epic_id])
    assert code == 0, f"epic ack on open epic failed:\n{output}"
    after = _read_epic(tmp_path, epic_id)
    # fn-488: tracked JSON never carries the ack field.
    assert "closer_acked_at" not in after
    assert after.get("closer_done_at") is None
    # ack landed in the SQLite side store regardless.
    assert acks_module.get_epic_ack(epic_id, repo_root=tmp_path) is not None


def test_ack_nonexistent_epic_errors(tmp_path, monkeypatch):
    _create_project(tmp_path, monkeypatch)
    code, _, output = _invoke(["epic", "ack", "fn-9999-no-epic"])
    assert code != 0
    assert "not found" in output.lower() or "fn-9999" in output


def test_ack_invalid_id_type_errors(tmp_path, monkeypatch):
    """Acking a task id via epic ack fails-visibly (not an epic id)."""
    _create_project(tmp_path, monkeypatch)
    from .conftest import seed_epic

    _epic_id, task_ids = seed_epic(tmp_path, title="ackable", n_tasks=1, env=_ENV)
    task_id = task_ids[0]
    code, _, output = _invoke(["epic", "ack", task_id])
    assert code != 0
    assert "invalid" in output.lower()


# ---------------------------------------------------------------------------
# fn-559: the fn-521 AUDIT_PENDING gate was reverted — ack on a closed epic
# succeeds immediately (no auditor stamp required first).
# ---------------------------------------------------------------------------


def test_ack_succeeds_on_closed_epic_no_audit_pending(tmp_path, monkeypatch):
    """fn-559: ack on a closed epic succeeds without AUDIT_PENDING.

    `epic close` stamps only `closer_done_at` (no auditor_done_at), and the
    ack verb no longer refuses with BLOCKED: AUDIT_PENDING — the audit ran
    inline inside `/plan:close` before the close mutation.
    """
    from planctl import acks as acks_module

    _create_project(tmp_path, monkeypatch)
    epic_id = _make_closed_epic(tmp_path)

    before = _read_epic(tmp_path, epic_id)
    assert before.get("closer_done_at") is not None
    assert "auditor_done_at" not in before

    code, obj, output = _invoke(["epic", "ack", epic_id])
    assert code == 0, f"ack must succeed (no AUDIT_PENDING gate):\n{output}"
    assert "AUDIT_PENDING" not in output
    assert obj.get("closer_acked_at") is not None
    assert acks_module.get_epic_ack(epic_id, repo_root=tmp_path) is not None


def test_ack_envelope_carries_planctl_invocation(tmp_path, monkeypatch):
    """The CLI envelope includes a planctl_invocation payload with op=epic-ack."""
    _create_project(tmp_path, monkeypatch)
    epic_id = _make_closed_epic(tmp_path)
    runner = CliRunner()
    result = runner.invoke(cli, ["epic", "ack", epic_id], env=_ENV)
    assert result.exit_code == 0
    assert '"planctl_invocation"' in result.output
    payload = json.loads(result.output.strip().splitlines()[-1])
    inv = payload.get("planctl_invocation") or {}
    assert inv.get("op") == "epic-ack"
    assert inv.get("target") == epic_id
