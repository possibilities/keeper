"""Tests for planctl approve — approval gate field + gates (fn-592 task .1).

Mutating verbs resolve the session id from CLAUDE_CODE_SESSION_ID; these
tests set it explicitly.

Renamed from ``test_set_approval.py`` when the verb was renamed from
``set-approval`` to ``approve``.  Covers the original four cases plus the
new approve-gates layered in by task .1:

(a) ``approve`` writes the file atomically and lands the correct status
    (both epic-level and task-level surfaces).
(b) Round-trip preserves unknown top-level fields.
(c) Invalid status enum is rejected at the CLI boundary.
(d) Approve-gates (fn-592 task .1):
    - Task ``approved`` requires merged ``status == "done"``.
    - Epic ``approved`` requires epic ``status == "done"`` AND every
      embedded task ``status == "done"`` AND every embedded task
      ``approval == "approved"``.
    - ``rejected`` / ``pending`` writes are always allowed.

Also pins the serializer form (indent, key order, trailing newline) so
keeperd writers can match byte-for-byte, and asserts the new verb name
stays OUT of ``VALIDATION_RESTAMP_VERBS``.
"""

from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path

from click.testing import CliRunner
from planctl.cli import cli
from planctl.models import (
    APPROVAL_STATUSES,
    merge_epic_state,
    merge_task_state,
    normalize_epic,
    normalize_task,
)
from planctl.store import LocalFileStateStore, atomic_write_json, now_iso
from planctl.validation_restamp import VALIDATION_RESTAMP_VERBS

_ENV = {**os.environ, "CLAUDE_CODE_SESSION_ID": "test-approve-fixture"}


def _create_project(tmp_path, monkeypatch):
    """Init a planctl project under a fresh git repo."""
    import subprocess

    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-approve-fixture")
    monkeypatch.chdir(tmp_path)
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    runner = CliRunner()
    result = runner.invoke(cli, ["init"], env=_ENV)
    assert result.exit_code == 0, result.output
    return tmp_path


def _invoke(args: list[str]) -> tuple[int, dict | None, str]:
    runner = CliRunner()
    result = runner.invoke(cli, args, env=_ENV)
    obj = _first_envelope(result.output)
    return result.exit_code, obj, result.output


def _first_envelope(output: str) -> dict | None:
    """Return the first non-planctl_invocation JSON object in *output*."""
    decoder = json.JSONDecoder()
    text = output
    i = 0
    while i < len(text):
        if text[i] == "{":
            with contextlib.suppress(json.JSONDecodeError):
                obj, end = decoder.raw_decode(text[i:])
                if (
                    isinstance(obj, dict)
                    and "planctl_invocation" in obj
                    and len(obj) == 1
                ):
                    i += end
                    continue
                return obj
        i += 1
    return None


def _read_epic(project_path, epic_id) -> dict:
    epic_path = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    return json.loads(epic_path.read_text())


def _read_task(project_path, task_id) -> dict:
    task_path = project_path / ".planctl" / "tasks" / f"{task_id}.json"
    return json.loads(task_path.read_text())


def _read_task_sidecar(project_path: Path, task_id: str) -> dict | None:
    store = LocalFileStateStore(project_path / ".planctl" / "state")
    return store.load_runtime(task_id)


def _read_epic_sidecar(project_path: Path, epic_id: str) -> dict | None:
    store = LocalFileStateStore(project_path / ".planctl" / "state")
    return store.load_epic_runtime(epic_id)


def _make_epic_with_tasks(n_tasks: int = 1):
    from .conftest import seed_epic

    epic_id, task_ids = seed_epic(
        Path.cwd(), title="Approval epic", n_tasks=n_tasks, env=_ENV
    )
    return epic_id, task_ids


def _make_epic_with_task():
    epic_id, task_ids = _make_epic_with_tasks(1)
    return epic_id, task_ids[0]


def _force_task_done(project_path: Path, task_id: str) -> None:
    """Mark a task's runtime state as ``status=done``.

    Bypasses the ``run_done`` claim/in_progress preconditions because the
    approve-gate tests care only about the post-condition (merged status).
    """
    state_dir = project_path / ".planctl" / "state"
    store = LocalFileStateStore(state_dir)
    store.save_runtime(
        task_id,
        {
            "status": "done",
            "updated_at": now_iso(),
            "assignee": "test",
            "claimed_at": now_iso(),
            "claim_note": "",
            "evidence": {"commits": [], "tests": [], "prs": []},
            "blocked_reason": None,
        },
    )


def _force_epic_done(project_path: Path, epic_id: str) -> None:
    """Flip an epic's on-disk JSON to ``status=done``.

    Bypasses ``run_epic_close``'s gate (which requires all tasks done +
    auditor stamps) — the approve-gate tests are scoped to the gate logic
    itself, not the close ceremony.
    """
    epic_path = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    data = json.loads(epic_path.read_text())
    data["status"] = "done"
    data["updated_at"] = now_iso()
    atomic_write_json(epic_path, data)


def _force_task_approval(project_path: Path, task_id: str, status: str) -> None:
    """Stamp ``approval`` directly on the task JSON (bypassing the CLI gate)."""
    task_path = project_path / ".planctl" / "tasks" / f"{task_id}.json"
    data = json.loads(task_path.read_text())
    data["approval"] = status
    data["updated_at"] = now_iso()
    atomic_write_json(task_path, data)


# ---------------------------------------------------------------------------
# fn-732: the "pending" default moved OUT of normalize_* and INTO the merge
# step. normalize carries the def's approval through untouched (incl. absent /
# null); merge_task_state / merge_epic_state apply the def → pending tail.
# ---------------------------------------------------------------------------


def test_normalize_epic_does_not_default_approval():
    """fn-732: normalize_epic no longer injects a pending default for approval."""
    data = {"id": "fn-1-test", "title": "Test", "status": "open"}
    normalize_epic(data)
    assert "approval" not in data


def test_normalize_task_does_not_default_approval():
    """fn-732: normalize_task no longer injects a pending default for approval."""
    data = {"id": "fn-1-test.1", "epic": "fn-1-test", "title": "Test"}
    normalize_task(data)
    assert "approval" not in data


def test_normalize_epic_preserves_existing_approval():
    """normalize_epic does not overwrite an explicitly-set approval."""
    data = {"id": "fn-1-t", "title": "X", "status": "open", "approval": "approved"}
    normalize_epic(data)
    assert data["approval"] == "approved"


def test_normalize_task_preserves_existing_approval():
    """normalize_task does not overwrite an explicitly-set approval."""
    data = {"id": "fn-1-t.1", "epic": "fn-1-t", "title": "X", "approval": "rejected"}
    normalize_task(data)
    assert data["approval"] == "rejected"


def test_merge_task_defaults_approval_to_pending():
    """fn-732: a def missing `approval` resolves to "pending" at merge."""
    definition = {"id": "fn-1-test.1", "epic": "fn-1-test", "title": "Test"}
    merged = merge_task_state(definition, None)
    assert merged["approval"] == "pending"


def test_merge_epic_defaults_approval_to_pending():
    """fn-732: a def missing `approval` resolves to "pending" at epic merge."""
    definition = {"id": "fn-1-test", "title": "Test", "status": "open"}
    merged = merge_epic_state(definition, None)
    assert merged["approval"] == "pending"


def test_merge_task_coerces_null_to_pending():
    """A serialized `approval: null` resolves to "pending" at merge."""
    definition = {"id": "fn-1-t.1", "epic": "fn-1-t", "title": "X", "approval": None}
    merged = merge_task_state(definition, None)
    assert merged["approval"] == "pending"


def test_merge_epic_coerces_null_to_pending():
    """A serialized epic `approval: null` resolves to "pending" at merge."""
    definition = {"id": "fn-1-t", "title": "X", "status": "open", "approval": None}
    merged = merge_epic_state(definition, None)
    assert merged["approval"] == "pending"


# ---------------------------------------------------------------------------
# fn-732 resolution ladder: sidecar > def > pending
# ---------------------------------------------------------------------------


def test_merge_task_ladder_sidecar_over_def():
    """A sidecar approval shadows the committed def approval (sidecar wins)."""
    definition = {
        "id": "fn-1-t.1",
        "epic": "fn-1-t",
        "title": "X",
        "approval": "pending",
    }
    runtime = {"status": "done", "approval": "approved"}
    merged = merge_task_state(definition, runtime)
    assert merged["approval"] == "approved"


def test_merge_task_ladder_def_when_no_sidecar_approval():
    """When the sidecar carries no approval, the def value wins."""
    definition = {
        "id": "fn-1-t.1",
        "epic": "fn-1-t",
        "title": "X",
        "approval": "rejected",
    }
    runtime = {"status": "done"}  # no approval key in sidecar
    merged = merge_task_state(definition, runtime)
    assert merged["approval"] == "rejected"


def test_merge_epic_ladder_sidecar_over_def():
    """An epic sidecar approval shadows the committed def approval."""
    definition = {"id": "fn-1-t", "title": "X", "status": "done", "approval": "pending"}
    epic_runtime = {"approval": "approved"}
    merged = merge_epic_state(definition, epic_runtime)
    assert merged["approval"] == "approved"


# ---------------------------------------------------------------------------
# (a) Happy path: approve lands the correct status atomically
#     Uses `rejected` or pre-staged done+approved fixtures so the new
#     fn-592 gates don't fire on the file-write coverage tests.
# ---------------------------------------------------------------------------


def test_approve_epic_writes_field_when_clean(tmp_path, monkeypatch):
    """`planctl approve <epic_id> approved` lands the sidecar when all gates pass.

    fn-732 task .2 contract: approve is runtime-state-only — it writes the
    gitignored sidecar, NOT the committed def.
    """
    _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _make_epic_with_task()
    _force_task_done(tmp_path, task_id)
    _force_task_approval(tmp_path, task_id, "approved")
    _force_epic_done(tmp_path, epic_id)

    code, obj, output = _invoke(["approve", epic_id, "approved"])
    assert code == 0, output
    assert obj is not None
    assert obj.get("epic_id") == epic_id
    assert obj.get("approval") == "approved"

    sidecar = _read_epic_sidecar(tmp_path, epic_id)
    assert sidecar is not None
    assert sidecar["approval"] == "approved"


def test_approve_task_writes_field_when_done(tmp_path, monkeypatch):
    """`planctl approve <epic_id> <task_id> approved` lands the sidecar when done."""
    _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _make_epic_with_task()
    _force_task_done(tmp_path, task_id)

    code, obj, output = _invoke(["approve", epic_id, task_id, "approved"])
    assert code == 0, output
    assert obj is not None
    assert obj.get("epic_id") == epic_id
    assert obj.get("task_id") == task_id
    assert obj.get("approval") == "approved"

    sidecar = _read_task_sidecar(tmp_path, task_id)
    assert sidecar is not None
    assert sidecar["approval"] == "approved"


def test_approve_task_rejected_unguarded(tmp_path, monkeypatch):
    """`approve <epic_id> <task_id> rejected` always succeeds — no done gate."""
    _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _make_epic_with_task()
    # Task is NOT done — rejected write must still land in the sidecar.
    code, obj, output = _invoke(["approve", epic_id, task_id, "rejected"])
    assert code == 0, output
    assert obj is not None
    sidecar = _read_task_sidecar(tmp_path, task_id)
    assert sidecar is not None
    assert sidecar["approval"] == "rejected"


def test_approve_overwrites_previous_value(tmp_path, monkeypatch):
    """Successive approve calls overwrite the sidecar cleanly (rejected/pending unguarded)."""
    _create_project(tmp_path, monkeypatch)
    epic_id, _ = _make_epic_with_task()
    # Use only unguarded transitions so the gate doesn't get in the way.
    for status in ("rejected", "pending", "rejected"):
        code, _, output = _invoke(["approve", epic_id, status])
        assert code == 0, output
        sidecar = _read_epic_sidecar(tmp_path, epic_id)
        assert sidecar is not None
        assert sidecar["approval"] == status


def test_approve_does_not_write_def(tmp_path, monkeypatch):
    """fn-732 task .2: approve must NOT mutate the committed def `approval`.

    The def file's approval is whatever it was at mint time ("pending") —
    approve writes only the gitignored sidecar.
    """
    _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _make_epic_with_task()
    _force_task_done(tmp_path, task_id)

    before_epic = _read_epic(tmp_path, epic_id).get("approval")
    before_task = _read_task(tmp_path, task_id).get("approval")

    code, _, output = _invoke(["approve", epic_id, task_id, "approved"])
    assert code == 0, output

    # Def unchanged — approval did not touch the committed file.
    assert _read_task(tmp_path, task_id).get("approval") == before_task
    assert _read_epic(tmp_path, epic_id).get("approval") == before_epic


# ---------------------------------------------------------------------------
# (b) Round-trip preserves all unknown top-level fields
# ---------------------------------------------------------------------------


def test_approve_leaves_def_unknown_fields_untouched(tmp_path, monkeypatch):
    """fn-732 task .2: approve never rewrites the def, so def fields are inert.

    Unknown fields injected on the committed def survive trivially because
    approve no longer touches the def at all — the contract makes the def
    write-side a no-op.
    """
    _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _make_epic_with_task()

    # Inject unknown fields directly on the on-disk JSON.
    epic_path = tmp_path / ".planctl" / "epics" / f"{epic_id}.json"
    epic_data = json.loads(epic_path.read_text())
    epic_data["future_keeper_field"] = {"shape": "nested", "n": 42}
    epic_data["future_scalar"] = "opaque-value"
    epic_path.write_text(json.dumps(epic_data, indent=2, sort_keys=True) + "\n")

    task_path = tmp_path / ".planctl" / "tasks" / f"{task_id}.json"
    task_data = json.loads(task_path.read_text())
    task_data["future_task_field"] = ["a", "b", "c"]
    task_path.write_text(json.dumps(task_data, indent=2, sort_keys=True) + "\n")

    # Approve through the CLI; the def is not rewritten.  Use unguarded
    # statuses so the fn-592 approve-gates don't fire.
    code, _, output = _invoke(["approve", epic_id, "rejected"])
    assert code == 0, output
    code, _, output = _invoke(["approve", epic_id, task_id, "rejected"])
    assert code == 0, output

    # Sidecar carries the approval.
    assert _read_epic_sidecar(tmp_path, epic_id)["approval"] == "rejected"  # type: ignore[index]
    assert _read_task_sidecar(tmp_path, task_id)["approval"] == "rejected"  # type: ignore[index]

    # Def is byte-for-byte what we wrote — approve touched nothing here.
    epic_after = json.loads(epic_path.read_text())
    assert epic_after["future_keeper_field"] == {"shape": "nested", "n": 42}
    assert epic_after["future_scalar"] == "opaque-value"
    task_after = json.loads(task_path.read_text())
    assert task_after["future_task_field"] == ["a", "b", "c"]


# ---------------------------------------------------------------------------
# (c) Invalid status enum is rejected at the CLI boundary
# ---------------------------------------------------------------------------


def test_approve_rejects_unknown_status(tmp_path, monkeypatch):
    """An out-of-vocabulary status fails non-zero before any I/O lands."""
    _create_project(tmp_path, monkeypatch)
    epic_id, _ = _make_epic_with_task()

    before = _read_epic(tmp_path, epic_id)
    code, _, output = _invoke(["approve", epic_id, "maybe"])
    assert code != 0
    after = _read_epic(tmp_path, epic_id)
    assert after.get("approval") == before.get("approval")


def test_approve_rejects_unknown_status_on_task(tmp_path, monkeypatch):
    """Same enum check on the task-level form."""
    _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _make_epic_with_task()
    before = _read_task(tmp_path, task_id)
    code, _, output = _invoke(["approve", epic_id, task_id, "soon"])
    assert code != 0
    after = _read_task(tmp_path, task_id)
    assert after.get("approval", "pending") == before.get("approval", "pending")


def test_approve_rejects_missing_epic(tmp_path, monkeypatch):
    """approve on an absent epic fails with a 'not found' message."""
    _create_project(tmp_path, monkeypatch)
    code, _, output = _invoke(["approve", "fn-9999-nope", "rejected"])
    assert code != 0
    assert "not found" in output.lower() or "fn-9999" in output


def test_approve_rejects_mismatched_epic_task(tmp_path, monkeypatch):
    """If <task_id>'s parent doesn't match <epic_id>, fail loudly."""
    _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _make_epic_with_task()
    bogus_epic = "fn-7777-other"
    code, _, output = _invoke(["approve", bogus_epic, task_id, "rejected"])
    assert code != 0


# ---------------------------------------------------------------------------
# (d) fn-592 task .1 approve-gates
# ---------------------------------------------------------------------------


def test_approve_task_refuses_when_status_not_done(tmp_path, monkeypatch):
    """Gate: `approve <task> approved` fails if the task's merged status != done.

    Freshly-scaffolded tasks default to runtime status `todo` (no runtime
    state file written yet → merge_task_state defaults to {"status": "todo"}).
    """
    _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _make_epic_with_task()

    before = _read_task(tmp_path, task_id)
    code, _, output = _invoke(["approve", epic_id, task_id, "approved"])
    assert code != 0, output
    assert "must be 'done'" in output or "status is" in output
    after = _read_task(tmp_path, task_id)
    assert after.get("approval", "pending") == before.get("approval", "pending")


def test_approve_task_rejected_works_when_not_done(tmp_path, monkeypatch):
    """Gate carve-out: rejected/pending writes succeed regardless of status."""
    _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _make_epic_with_task()
    # Task is `todo`, but rejected/pending bypass the gate.
    for status in ("rejected", "pending"):
        code, _, output = _invoke(["approve", epic_id, task_id, status])
        assert code == 0, output
        assert _read_task_sidecar(tmp_path, task_id)["approval"] == status  # type: ignore[index]


def test_approve_epic_refuses_when_epic_not_done(tmp_path, monkeypatch):
    """Gate: epic `approved` fails when epic.status != done."""
    _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _make_epic_with_task()
    # Even with the task done + approved, the epic itself is still open.
    _force_task_done(tmp_path, task_id)
    _force_task_approval(tmp_path, task_id, "approved")

    code, _, output = _invoke(["approve", epic_id, "approved"])
    assert code != 0, output
    assert "epic" in output.lower() and (
        "must be 'done'" in output or "status is" in output
    )
    assert _read_epic(tmp_path, epic_id).get("approval") != "approved"


def test_approve_epic_refuses_when_any_task_not_done(tmp_path, monkeypatch):
    """Gate: epic `approved` fails when at least one task is not done."""
    _create_project(tmp_path, monkeypatch)
    epic_id, task_ids = _make_epic_with_tasks(n_tasks=2)
    t1, t2 = task_ids

    # Mark only t1 done+approved; t2 stays todo.
    _force_task_done(tmp_path, t1)
    _force_task_approval(tmp_path, t1, "approved")
    _force_epic_done(tmp_path, epic_id)

    code, _, output = _invoke(["approve", epic_id, "approved"])
    assert code != 0, output
    assert t2 in output
    assert _read_epic(tmp_path, epic_id).get("approval") != "approved"


def test_approve_epic_refuses_when_any_task_not_approved(tmp_path, monkeypatch):
    """Gate: epic `approved` fails when at least one task isn't approved."""
    _create_project(tmp_path, monkeypatch)
    epic_id, task_ids = _make_epic_with_tasks(n_tasks=2)
    t1, t2 = task_ids

    # Both tasks done; only t1 approved.
    _force_task_done(tmp_path, t1)
    _force_task_done(tmp_path, t2)
    _force_task_approval(tmp_path, t1, "approved")
    # t2 stays pending.
    _force_epic_done(tmp_path, epic_id)

    code, _, output = _invoke(["approve", epic_id, "approved"])
    assert code != 0, output
    assert t2 in output
    assert "approved" in output.lower()
    assert _read_epic(tmp_path, epic_id).get("approval") != "approved"


def test_approve_epic_succeeds_when_fully_clean(tmp_path, monkeypatch):
    """Gate happy path: epic done + every task done + every task approved → success."""
    _create_project(tmp_path, monkeypatch)
    epic_id, task_ids = _make_epic_with_tasks(n_tasks=3)

    for tid in task_ids:
        _force_task_done(tmp_path, tid)
        _force_task_approval(tmp_path, tid, "approved")
    _force_epic_done(tmp_path, epic_id)

    code, _, output = _invoke(["approve", epic_id, "approved"])
    assert code == 0, output
    assert _read_epic_sidecar(tmp_path, epic_id)["approval"] == "approved"  # type: ignore[index]


def test_approve_epic_rejected_unguarded_across_all_states(tmp_path, monkeypatch):
    """Gate carve-out: epic rejected/pending writes succeed in every state combo."""
    _create_project(tmp_path, monkeypatch)
    epic_id, task_ids = _make_epic_with_tasks(n_tasks=2)
    t1, t2 = task_ids

    # State combo 1: nothing done, nothing approved.
    for status in ("rejected", "pending"):
        code, _, output = _invoke(["approve", epic_id, status])
        assert code == 0, output
        assert _read_epic_sidecar(tmp_path, epic_id)["approval"] == status  # type: ignore[index]

    # State combo 2: epic done but tasks still mixed — rejected still fine.
    _force_task_done(tmp_path, t1)
    _force_epic_done(tmp_path, epic_id)
    for status in ("rejected", "pending"):
        code, _, output = _invoke(["approve", epic_id, status])
        assert code == 0, output
        assert _read_epic_sidecar(tmp_path, epic_id)["approval"] == status  # type: ignore[index]

    # State combo 3: everything ready for approval — rejected still allowed
    # (operator may want to flip an already-approvable epic into the reject
    # bucket without trying to approve it first).
    _force_task_done(tmp_path, t2)
    _force_task_approval(tmp_path, t1, "approved")
    _force_task_approval(tmp_path, t2, "approved")
    for status in ("rejected", "pending"):
        code, _, output = _invoke(["approve", epic_id, status])
        assert code == 0, output
        assert _read_epic_sidecar(tmp_path, epic_id)["approval"] == status  # type: ignore[index]


# ---------------------------------------------------------------------------
# Serializer form pinning — exact bytes documented for downstream keeperd
# ---------------------------------------------------------------------------


def test_serializer_form_is_indent2_sortkeys_trailing_newline(tmp_path, monkeypatch):
    """Pin the exact on-disk sidecar form so keeperd can match byte-for-byte:
    - indent=2 spaces
    - sort_keys=True (keys lexicographic)
    - trailing newline (single "\\n" after the closing "}")
    - UTF-8 encoding
    """
    _create_project(tmp_path, monkeypatch)
    epic_id, _ = _make_epic_with_task()
    code, _, output = _invoke(["approve", epic_id, "rejected"])
    assert code == 0, output

    epic_path = tmp_path / ".planctl" / "state" / "epics" / f"{epic_id}.state.json"
    raw = epic_path.read_bytes()
    assert raw.endswith(b"\n"), "missing trailing newline"
    text = raw.decode("utf-8")
    parsed = json.loads(text)
    rebuilt = json.dumps(parsed, indent=2, sort_keys=True) + "\n"
    assert text == rebuilt, (
        "on-disk form does not match the canonical "
        '`json.dumps(data, indent=2, sort_keys=True) + "\\n"` shape'
    )


# ---------------------------------------------------------------------------
# Validation marker: approve must NOT re-stamp last_validated_at
# ---------------------------------------------------------------------------


def test_approve_not_in_validation_restamp_verbs():
    """`approve` is human gating state, not structural — must NOT re-stamp marker.

    Mirrors the old `set-approval` exclusion (pre-rename).  Approval flips
    must never invalidate the epic's structural `last_validated_at` marker.
    """
    assert "approve" not in VALIDATION_RESTAMP_VERBS, (
        "'approve' must not appear in VALIDATION_RESTAMP_VERBS — "
        "approval is gating state, not structural plan content"
    )
    # Sanity: the old verb name must also be gone (the rename target).
    assert "set-approval" not in VALIDATION_RESTAMP_VERBS


# ---------------------------------------------------------------------------
# APPROVAL_STATUSES enum pinning
# ---------------------------------------------------------------------------


def test_approval_statuses_constant():
    """The enum is exactly {approved, rejected, pending}."""
    assert set(APPROVAL_STATUSES) == {"approved", "rejected", "pending"}


# ---------------------------------------------------------------------------
# Envelope shape — planctl_invocation rides through approve
# ---------------------------------------------------------------------------


def test_approve_envelope_carries_planctl_invocation(tmp_path, monkeypatch):
    """Mutating verbs emit a planctl_invocation payload with op=approve."""
    _create_project(tmp_path, monkeypatch)
    epic_id, _ = _make_epic_with_task()
    runner = CliRunner()
    result = runner.invoke(cli, ["approve", epic_id, "rejected"], env=_ENV)
    assert result.exit_code == 0, result.output
    assert '"planctl_invocation"' in result.output
    assert '"approve"' in result.output


# ---------------------------------------------------------------------------
# CLI surface: set-approval is gone from the registered command list.
# ---------------------------------------------------------------------------


def test_set_approval_subcommand_removed():
    """The old `set-approval` subcommand is no longer registered on the CLI."""
    assert "set-approval" not in cli.commands  # type: ignore[attr-defined]
    assert "approve" in cli.commands  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Cwd-agnostic resolution — approve from outside the epic's repo.
# Mirrors test_resolve_task.py's two-projects-with-same-task pattern.
# ---------------------------------------------------------------------------


def _make_two_projects(tmp_path, monkeypatch):
    """Seed two sibling planctl projects under a shared root.

    Each project gets its own git repo + ``planctl init``. The configured
    ``roots`` CONFIG_PATH is pointed at the shared parent so discovery surfaces
    both projects as candidates. Returns ``(proj_a, proj_b)``.
    """
    import subprocess

    root = tmp_path / "_approve_root"
    root.mkdir()
    proj_a = root / "proj-a"
    proj_a.mkdir()
    proj_b = root / "proj-b"
    proj_b.mkdir()

    for proj in (proj_a, proj_b):
        subprocess.run(["git", "init"], cwd=proj, check=True, capture_output=True)
        # Committer identity / gpgsign / hooksPath ride GIT_CONFIG_GLOBAL (set by
        # the session-scoped _git_global_config fixture) — no per-repo config.
        (proj / "README.md").write_text("# test\n")
        subprocess.run(
            ["git", "add", "README.md"], cwd=proj, check=True, capture_output=True
        )
        subprocess.run(
            ["git", "commit", "-m", "chore: initial"],
            cwd=proj,
            check=True,
            capture_output=True,
        )
        monkeypatch.chdir(proj)
        runner = CliRunner()
        result = runner.invoke(cli, ["init"], env=_ENV)
        assert result.exit_code == 0, result.output

    cfg = tmp_path / "_approve_roots_config.yaml"
    cfg.write_text(f"roots:\n  - {root}\n", encoding="utf-8")
    monkeypatch.setattr("planctl.config.CONFIG_PATH", cfg)
    return proj_a, proj_b


def test_approve_task_from_outside_epic_repo(tmp_path, monkeypatch):
    """`planctl approve` lands on the task whose epic lives in a sibling repo.

    Reproduces the original bug: cwd-anchored ``resolve_project()`` failed with
    "Task not found" when the operator invoked approve from a repo whose
    ``.planctl/`` does NOT own the target. Cwd-agnostic resolution should now
    pick up proj_b's task even though cwd sits in proj_a.
    """
    from .conftest import seed_epic

    proj_a, proj_b = _make_two_projects(tmp_path, monkeypatch)

    monkeypatch.chdir(proj_b)
    epic_id, task_ids = seed_epic(proj_b, title="cross-repo", n_tasks=1, env=_ENV)
    task_id = task_ids[0]
    _force_task_done(proj_b, task_id)

    # cwd lives in proj_a; the target task lives in proj_b's .planctl/.
    monkeypatch.chdir(proj_a)
    code, obj, output = _invoke(["approve", epic_id, task_id, "approved"])
    assert code == 0, output
    assert obj is not None
    assert obj.get("task_id") == task_id
    assert obj.get("approval") == "approved"

    after = _read_task_sidecar(proj_b, task_id)
    assert after is not None
    assert after.get("approval") == "approved"


def test_approve_epic_from_outside_epic_repo(tmp_path, monkeypatch):
    """Epic-level approve also resolves cwd-agnostically via roots discovery."""
    from .conftest import seed_epic

    proj_a, proj_b = _make_two_projects(tmp_path, monkeypatch)

    monkeypatch.chdir(proj_b)
    epic_id, task_ids = seed_epic(proj_b, title="cross-repo epic", n_tasks=1, env=_ENV)
    task_id = task_ids[0]
    _force_task_done(proj_b, task_id)
    _force_task_approval(proj_b, task_id, "approved")
    _force_epic_done(proj_b, epic_id)

    monkeypatch.chdir(proj_a)
    code, obj, output = _invoke(["approve", epic_id, "approved"])
    assert code == 0, output
    assert obj is not None
    assert obj.get("epic_id") == epic_id
    assert obj.get("approval") == "approved"

    after = _read_epic_sidecar(proj_b, epic_id)
    assert after is not None
    assert after.get("approval") == "approved"


def test_approve_task_not_found_when_no_project_holds_it(tmp_path, monkeypatch):
    """Zero matches across discovered roots → "Task not found" envelope."""
    _make_two_projects(tmp_path, monkeypatch)
    code, obj, output = _invoke(
        ["approve", "fn-9999-nonexistent", "fn-9999-nonexistent.1", "rejected"]
    )
    assert code != 0, output
    assert obj is not None
    assert obj.get("success") is False
    assert "Task not found" in str(obj.get("error", ""))


def test_approve_epic_not_found_when_no_project_holds_it(tmp_path, monkeypatch):
    """Zero matches across discovered roots for an epic id → "Epic not found"."""
    _make_two_projects(tmp_path, monkeypatch)
    code, obj, output = _invoke(["approve", "fn-9999-nonexistent", "rejected"])
    assert code != 0, output
    assert obj is not None
    assert obj.get("success") is False
    assert "Epic not found" in str(obj.get("error", ""))


def test_approve_project_flag_disambiguates(tmp_path, monkeypatch):
    """--project <path> bypasses discovery and targets a specific project."""
    from .conftest import seed_epic

    proj_a, proj_b = _make_two_projects(tmp_path, monkeypatch)

    monkeypatch.chdir(proj_b)
    epic_id, task_ids = seed_epic(proj_b, title="explicit project", n_tasks=1, env=_ENV)
    task_id = task_ids[0]

    # Override roots so discovery would otherwise miss the target — only
    # --project should make this succeed.
    cfg = tmp_path / "_empty_roots_config.yaml"
    cfg.write_text("roots: []\n", encoding="utf-8")
    monkeypatch.setattr("planctl.config.CONFIG_PATH", cfg)

    monkeypatch.chdir(proj_a)
    code, obj, output = _invoke(
        ["approve", "--project", str(proj_b), epic_id, task_id, "rejected"]
    )
    assert code == 0, output
    assert obj is not None
    assert obj.get("task_id") == task_id
    assert obj.get("approval") == "rejected"


def test_approve_project_flag_not_a_planctl_project(tmp_path):
    """--project <path> on a dir without .planctl/ surfaces a typed not-a-project error."""
    bare = tmp_path / "bare-dir"
    bare.mkdir()
    code, obj, output = _invoke(
        ["approve", "--project", str(bare), "fn-1-x", "fn-1-x.1", "rejected"]
    )
    assert code != 0, output
    assert obj is not None
    assert obj.get("success") is False
    assert "No planctl project found" in str(obj.get("error", ""))


def test_approve_ambiguous_task_id_across_projects(tmp_path, monkeypatch):
    """Same task id in two projects under discovery roots → ambiguous error.

    Stages the cwd outside both projects so the cwd-first short-circuit
    doesn't pick a winner — discovery has to surface the ambiguity.
    """
    import shutil

    from .conftest import seed_epic

    proj_a, proj_b = _make_two_projects(tmp_path, monkeypatch)

    monkeypatch.chdir(proj_a)
    epic_id, task_ids = seed_epic(proj_a, title="ambig", n_tasks=1, env=_ENV)
    task_id = task_ids[0]

    # Duplicate proj_a's epic + task JSON into proj_b so discovery sees both.
    (proj_b / ".planctl" / "tasks").mkdir(parents=True, exist_ok=True)
    (proj_b / ".planctl" / "epics").mkdir(parents=True, exist_ok=True)
    shutil.copy(
        proj_a / ".planctl" / "tasks" / f"{task_id}.json",
        proj_b / ".planctl" / "tasks" / f"{task_id}.json",
    )
    shutil.copy(
        proj_a / ".planctl" / "epics" / f"{epic_id}.json",
        proj_b / ".planctl" / "epics" / f"{epic_id}.json",
    )

    # Move cwd to a neutral non-planctl directory so the cwd-first lookup
    # misses and discovery runs.
    neutral = tmp_path / "_neutral"
    neutral.mkdir()
    monkeypatch.chdir(neutral)

    code, obj, output = _invoke(["approve", epic_id, task_id, "rejected"])
    assert code != 0, output
    assert obj is not None
    assert obj.get("success") is False
    assert "exists in multiple projects" in str(obj.get("error", ""))
    assert "--project" in str(obj.get("error", ""))


# ---------------------------------------------------------------------------
# fn-732 CONTRACT (task .2): approve is runtime-state-only. It writes ONLY the
# gitignored sidecar — no def write, no auto-commit (mirrors claim/block).
# ---------------------------------------------------------------------------


def test_approve_task_writes_sidecar_only(tmp_path, monkeypatch):
    """`approve <task> approved` lands approval on the sidecar, NOT the def."""
    _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _make_epic_with_task()
    _force_task_done(tmp_path, task_id)

    before_def = _read_task(tmp_path, task_id).get("approval")

    code, _, output = _invoke(["approve", epic_id, task_id, "approved"])
    assert code == 0, output

    # Sidecar carries approval (the canonical source).
    sidecar = _read_task_sidecar(tmp_path, task_id)
    assert sidecar is not None
    assert sidecar["approval"] == "approved"
    # Def is untouched — approve did not rewrite the committed file.
    assert _read_task(tmp_path, task_id).get("approval") == before_def


def test_approve_emits_readonly_invocation_no_commit(tmp_path, monkeypatch):
    """fn-732 task .2: approve emits a NULL-subject/NULL-files invocation.

    Runtime-state-only verbs carry ``subject``/``files`` = null so the
    auto-commit helper no-ops — no ``.planctl/`` commit lands (mirrors
    claim/block).
    """
    _create_project(tmp_path, monkeypatch)
    epic_id, _ = _make_epic_with_task()
    runner = CliRunner()
    result = runner.invoke(cli, ["approve", epic_id, "rejected"], env=_ENV)
    assert result.exit_code == 0, result.output

    # Find the planctl_invocation payload and assert the runtime-only shape.
    decoder = json.JSONDecoder()
    text = result.output
    pc = None
    i = 0
    while i < len(text):
        if text[i] == "{":
            try:
                obj, end = decoder.raw_decode(text[i:])
            except json.JSONDecodeError:
                i += 1
                continue
            if isinstance(obj, dict) and "planctl_invocation" in obj:
                pc = obj["planctl_invocation"]
                break
            i += end
            continue
        i += 1
    assert pc is not None, f"no planctl_invocation in output: {result.output}"
    assert pc["op"] == "approve"
    assert pc["subject"] is None
    assert pc["files"] is None


def test_approve_task_write_preserves_status_in_sidecar(tmp_path, monkeypatch):
    """The approval write must not clobber the task's runtime `status`.

    The done state lands `status=done` in the sidecar first; an approve write
    is a RMW under lock_task that touches only the approval key, so status
    survives.
    """
    _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _make_epic_with_task()
    _force_task_done(tmp_path, task_id)
    # Sanity: status is present before approve.
    pre = _read_task_sidecar(tmp_path, task_id)
    assert pre is not None
    assert pre["status"] == "done"

    code, _, output = _invoke(["approve", epic_id, task_id, "approved"])
    assert code == 0, output

    sidecar = _read_task_sidecar(tmp_path, task_id)
    assert sidecar is not None
    assert sidecar["status"] == "done", "RMW clobbered the runtime status"
    assert sidecar["approval"] == "approved"
    # Other runtime fields ride through untouched.
    assert sidecar["assignee"] == "test"


def test_approve_epic_writes_sidecar_only(tmp_path, monkeypatch):
    """`approve <epic> approved` lands approval on the epic sidecar, NOT the def."""
    _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _make_epic_with_task()
    _force_task_done(tmp_path, task_id)
    _force_task_approval(tmp_path, task_id, "approved")
    _force_epic_done(tmp_path, epic_id)

    before_def = _read_epic(tmp_path, epic_id).get("approval")

    code, _, output = _invoke(["approve", epic_id, "approved"])
    assert code == 0, output

    sidecar = _read_epic_sidecar(tmp_path, epic_id)
    assert sidecar is not None
    assert sidecar["approval"] == "approved"
    # Def untouched.
    assert _read_epic(tmp_path, epic_id).get("approval") == before_def


def test_approve_epic_gate_reads_task_sidecar_approval(tmp_path, monkeypatch):
    """Epic gate resolves each task's approval via the ladder (sidecar wins).

    A task approved through the CLI lands its approval canonically on the
    sidecar; the epic gate must see it via merge_task_state. The task approve
    is sidecar-only now, so the gate must read the sidecar to pass.
    """
    _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _make_epic_with_task()
    _force_task_done(tmp_path, task_id)
    # Approve the task through the CLI (sidecar-only).
    code, _, output = _invoke(["approve", epic_id, task_id, "approved"])
    assert code == 0, output

    _force_epic_done(tmp_path, epic_id)
    # Epic gate must pass — task approval resolves to "approved" via the sidecar.
    code, _, output = _invoke(["approve", epic_id, "approved"])
    assert code == 0, output
    assert _read_epic_sidecar(tmp_path, epic_id)["approval"] == "approved"  # type: ignore[index]


def test_approve_epic_gate_sees_sidecar_only_task_approval(tmp_path, monkeypatch):
    """Gate ladder: a sidecar-only task approval (def 'pending') passes.

    Post-contract, a task approve writes only the sidecar — the committed def
    keeps its mint-time "pending". The epic gate reads merge_task_state, so the
    sidecar's "approved" shadows the def's "pending".
    """
    _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _make_epic_with_task()
    _force_task_done(tmp_path, task_id)
    # Sidecar-only approval; the committed def is NOT "approved" (it resolves
    # to pending via the merge tail), so only the sidecar carries the approval.
    store = LocalFileStateStore(tmp_path / ".planctl" / "state")
    store.write_task_approval(task_id, "approved")
    assert _read_task(tmp_path, task_id).get("approval") != "approved"

    _force_epic_done(tmp_path, epic_id)
    code, _, output = _invoke(["approve", epic_id, "approved"])
    assert code == 0, output
    assert _read_epic_sidecar(tmp_path, epic_id)["approval"] == "approved"  # type: ignore[index]


# ---------------------------------------------------------------------------
# fn-732 store API: read-never-creates + RMW-under-lock concurrent-writer
# ---------------------------------------------------------------------------


def test_store_read_task_approval_absent_returns_none(tmp_path):
    """read_task_approval on a never-written task returns None (no file created)."""
    store = LocalFileStateStore(tmp_path / "state")
    assert store.read_task_approval("fn-1-x.1") is None
    # Read must not create the sidecar file or the tasks dir.
    assert not (tmp_path / "state" / "tasks" / "fn-1-x.1.state.json").exists()


def test_store_read_epic_approval_absent_returns_none(tmp_path):
    """read_epic_approval on a never-written epic returns None (no file created)."""
    store = LocalFileStateStore(tmp_path / "state")
    assert store.read_epic_approval("fn-1-x") is None
    assert not (tmp_path / "state" / "epics" / "fn-1-x.state.json").exists()


def test_store_write_task_approval_rmw_preserves_status(tmp_path, monkeypatch):
    """write_task_approval RMW preserves a pre-existing runtime status."""
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-store-rmw")
    store = LocalFileStateStore(tmp_path / "state")
    store.save_runtime("fn-1-x.1", {"status": "done", "assignee": "alice"})

    store.write_task_approval("fn-1-x.1", "approved")

    runtime = store.load_runtime("fn-1-x.1")
    assert runtime is not None
    assert runtime["status"] == "done"
    assert runtime["assignee"] == "alice"
    assert runtime["approval"] == "approved"


def test_store_write_task_approval_seeds_absent_sidecar(tmp_path, monkeypatch):
    """write_task_approval on an absent sidecar seeds an approval-only dict."""
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-store-seed")
    store = LocalFileStateStore(tmp_path / "state")
    store.write_task_approval("fn-1-x.1", "rejected")
    runtime = store.load_runtime("fn-1-x.1")
    assert runtime == {"approval": "rejected"}


def test_store_write_epic_approval_rmw(tmp_path, monkeypatch):
    """write_epic_approval RMW preserves any pre-existing epic-runtime keys."""
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-store-epic-rmw")
    store = LocalFileStateStore(tmp_path / "state")
    store.save_epic_runtime("fn-1-x", {"approval": "pending", "future": "keep"})

    store.write_epic_approval("fn-1-x", "approved")

    runtime = store.load_epic_runtime("fn-1-x")
    assert runtime is not None
    assert runtime["approval"] == "approved"
    assert runtime["future"] == "keep"


def test_store_concurrent_status_and_approval_under_lock(tmp_path, monkeypatch):
    """A concurrent status write + approval write serialize without data loss.

    Two threads contend on lock_task: one writes status=done (RMW), the other
    writes approval=approved (RMW). After both, the sidecar must carry BOTH
    fields — neither write may clobber the other.
    """
    import threading

    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-store-concurrent")
    store = LocalFileStateStore(tmp_path / "state")
    # Seed an in_progress state so both writers RMW a non-empty file.
    store.save_runtime("fn-1-x.1", {"status": "in_progress", "assignee": "bob"})

    barrier = threading.Barrier(2)

    def write_status():
        barrier.wait()
        with store.lock_task("fn-1-x.1"):
            rt = store.load_runtime("fn-1-x.1") or {}
            rt["status"] = "done"
            store.save_runtime("fn-1-x.1", rt)

    def write_approval():
        barrier.wait()
        store.write_task_approval("fn-1-x.1", "approved")

    t1 = threading.Thread(target=write_status)
    t2 = threading.Thread(target=write_approval)
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    runtime = store.load_runtime("fn-1-x.1")
    assert runtime is not None
    assert runtime["status"] == "done", "status write was lost"
    assert runtime["approval"] == "approved", "approval write was lost"
    assert runtime["assignee"] == "bob"
