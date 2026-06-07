"""Tests for planctl approve — approval gate field + gates + sidecar move.

Mutating verbs resolve the session id from CLAUDE_CODE_SESSION_ID; these
tests set it explicitly.

fn-732: ``approval`` moved off the tracked def files into the gitignored
runtime sidecars (``state/tasks/<id>.state.json`` alongside ``status``;
new ``state/epics/<id>.state.json``). ``approve`` is reclassified
runtime-state-only — it no longer mutates the def file and lands no commit.
The resolution ladder (sidecar > def > pending) lives in
``merge_task_state`` / ``merge_epic_state``.

Covers:

(a) ``approve`` writes the SIDECAR (task: RMW under lock preserving a
    concurrent ``status``; epic: new sidecar) and the def file carries no
    approval after.
(b) Round-trip preserves unknown top-level fields on the def file (which
    approve no longer touches).
(c) Invalid status enum is rejected at the CLI boundary.
(d) Approve-gates (fn-592 task .1):
    - Task ``approved`` requires merged ``status == "done"``.
    - Epic ``approved`` requires epic ``status == "done"`` AND every
      embedded task ``status == "done"`` AND every embedded task merged
      ``approval == "approved"`` (read via the ladder, not the def field).
    - ``rejected`` / ``pending`` writes are always allowed.
(e) ``approve`` is runtime-state-only — no auto-commit.

Also pins the serializer form (indent, key order, trailing newline) so
keeperd writers can match byte-for-byte, and asserts the verb stays OUT of
``VALIDATION_RESTAMP_VERBS``.
"""

from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path

import pytest
from click.testing import CliRunner
from planctl.cli import cli
from planctl.models import APPROVAL_STATUSES, normalize_epic, normalize_task
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


def _read_task_sidecar(project_path, task_id) -> dict | None:
    """Load the gitignored task runtime sidecar, or None if absent (fn-732)."""
    store = LocalFileStateStore(project_path / ".planctl" / "state")
    return store.load_runtime(task_id)


def _read_epic_sidecar(project_path, epic_id) -> dict | None:
    """Load the gitignored epic runtime sidecar, or None if absent (fn-732)."""
    store = LocalFileStateStore(project_path / ".planctl" / "state")
    return store.load_epic_runtime(epic_id)


def _merged_task_approval(project_path, task_id) -> str:
    """Resolve a task's merged approval via the public ladder (fn-732)."""
    from planctl.models import merge_task_state

    task_def = _read_task(project_path, task_id)
    runtime = _read_task_sidecar(project_path, task_id)
    return merge_task_state(task_def, runtime)["approval"]


def _merged_epic_approval(project_path, epic_id) -> str:
    """Resolve an epic's merged approval via the public ladder (fn-732)."""
    from planctl.models import merge_epic_state

    epic_def = _read_epic(project_path, epic_id)
    runtime = _read_epic_sidecar(project_path, epic_id)
    return merge_epic_state(epic_def, runtime)["approval"]


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
    """Stamp ``approval`` directly on the task SIDECAR (bypassing the CLI gate).

    fn-732: approval lives in the gitignored runtime sidecar, not the def
    file, so the epic-gate's merged read resolves it from here.
    """
    store = LocalFileStateStore(project_path / ".planctl" / "state")
    runtime = store.load_runtime(task_id) or {}
    runtime["approval"] = status
    runtime["updated_at"] = now_iso()
    store.save_runtime(task_id, runtime)


# ---------------------------------------------------------------------------
# fn-732: the "pending" default lives ONLY in the merge step, not normalize_*.
# normalize must neither default nor strip a def `approval` value.
# ---------------------------------------------------------------------------


def test_normalize_epic_does_not_default_approval():
    """fn-732: normalize_epic no longer injects the "pending" default."""
    data = {"id": "fn-1-test", "title": "Test", "status": "open"}
    normalize_epic(data)
    assert "approval" not in data


def test_normalize_task_does_not_default_approval():
    """fn-732: normalize_task no longer injects the "pending" default."""
    data = {"id": "fn-1-test.1", "epic": "fn-1-test", "title": "Test"}
    normalize_task(data)
    assert "approval" not in data


def test_normalize_epic_preserves_existing_def_approval():
    """normalize_epic carries a pre-cutover def `approval` through untouched."""
    data = {"id": "fn-1-t", "title": "X", "status": "open", "approval": "approved"}
    normalize_epic(data)
    assert data["approval"] == "approved"


def test_normalize_task_preserves_existing_def_approval():
    """normalize_task carries a pre-cutover def `approval` through untouched."""
    data = {"id": "fn-1-t.1", "epic": "fn-1-t", "title": "X", "approval": "rejected"}
    normalize_task(data)
    assert data["approval"] == "rejected"


# ---------------------------------------------------------------------------
# (a) Happy path: approve lands the correct status atomically
#     Uses `rejected` or pre-staged done+approved fixtures so the new
#     fn-592 gates don't fire on the file-write coverage tests.
# ---------------------------------------------------------------------------


def test_approve_epic_writes_sidecar_when_clean(tmp_path, monkeypatch):
    """`planctl approve <epic_id> approved` writes the epic SIDECAR when gates pass.

    fn-732: the def file is NOT mutated; the new gitignored epic sidecar
    carries the approval.
    """
    _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _make_epic_with_task()
    _force_task_done(tmp_path, task_id)
    _force_task_approval(tmp_path, task_id, "approved")
    _force_epic_done(tmp_path, epic_id)

    def_before = _read_epic(tmp_path, epic_id)
    code, obj, output = _invoke(["approve", epic_id, "approved"])
    assert code == 0, output
    assert obj is not None
    assert obj.get("epic_id") == epic_id
    assert obj.get("approval") == "approved"

    # Sidecar carries the new value.
    sidecar = _read_epic_sidecar(tmp_path, epic_id)
    assert sidecar is not None
    assert sidecar.get("approval") == "approved"
    assert sidecar.get("updated_at")
    # Def file's approval field is unchanged by approve (no def mutation).
    def_after = _read_epic(tmp_path, epic_id)
    assert def_after.get("approval") == def_before.get("approval")
    # Merged read resolves to the sidecar value.
    assert _merged_epic_approval(tmp_path, epic_id) == "approved"


def test_approve_task_writes_sidecar_when_done(tmp_path, monkeypatch):
    """`planctl approve <epic_id> <task_id> approved` writes the task SIDECAR.

    fn-732: the def file is NOT mutated.
    """
    _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _make_epic_with_task()
    _force_task_done(tmp_path, task_id)

    def_before = _read_task(tmp_path, task_id)
    code, obj, output = _invoke(["approve", epic_id, task_id, "approved"])
    assert code == 0, output
    assert obj is not None
    assert obj.get("epic_id") == epic_id
    assert obj.get("task_id") == task_id
    assert obj.get("approval") == "approved"

    sidecar = _read_task_sidecar(tmp_path, task_id)
    assert sidecar is not None
    assert sidecar.get("approval") == "approved"
    # Def file's approval field is unchanged by approve.
    def_after = _read_task(tmp_path, task_id)
    assert def_after.get("approval") == def_before.get("approval")
    assert _merged_task_approval(tmp_path, task_id) == "approved"


def test_approve_task_rmw_preserves_status(tmp_path, monkeypatch):
    """fn-732: task approve is RMW — it preserves a concurrent `status` write.

    `_force_task_done` writes a full runtime sidecar with `status=done`.
    The approve write must add `approval` WITHOUT clobbering `status` (or any
    other key the status writer set).
    """
    _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _make_epic_with_task()
    _force_task_done(tmp_path, task_id)

    before = _read_task_sidecar(tmp_path, task_id)
    assert before is not None
    assert before.get("status") == "done"

    code, _, output = _invoke(["approve", epic_id, task_id, "approved"])
    assert code == 0, output

    after = _read_task_sidecar(tmp_path, task_id)
    assert after is not None
    # approval added …
    assert after.get("approval") == "approved"
    # … and the status writer's fields survived (RMW, not blind replace).
    assert after.get("status") == "done"
    assert after.get("assignee") == before.get("assignee")
    assert after.get("claimed_at") == before.get("claimed_at")
    assert after.get("evidence") == before.get("evidence")


def test_approve_task_creates_sidecar_when_absent(tmp_path, monkeypatch):
    """fn-732: an unguarded task approve creates the sidecar from scratch.

    A freshly-scaffolded task has no runtime sidecar yet (status defaults to
    todo). A `rejected` approve must create the sidecar with `approval` and
    not raise on the absent file (load-or-default to {}).
    """
    _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _make_epic_with_task()
    assert _read_task_sidecar(tmp_path, task_id) is None

    code, _, output = _invoke(["approve", epic_id, task_id, "rejected"])
    assert code == 0, output
    sidecar = _read_task_sidecar(tmp_path, task_id)
    assert sidecar is not None
    assert sidecar.get("approval") == "rejected"


def test_approve_task_rejected_unguarded(tmp_path, monkeypatch):
    """`approve <epic_id> <task_id> rejected` always succeeds — no done gate."""
    _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _make_epic_with_task()
    # Task is NOT done — rejected write must still land (on the sidecar).
    code, obj, output = _invoke(["approve", epic_id, task_id, "rejected"])
    assert code == 0, output
    assert obj is not None
    assert _merged_task_approval(tmp_path, task_id) == "rejected"


def test_approve_overwrites_previous_value(tmp_path, monkeypatch):
    """Successive approve calls overwrite the field cleanly (rejected/pending unguarded)."""
    _create_project(tmp_path, monkeypatch)
    epic_id, _ = _make_epic_with_task()
    # Use only unguarded transitions so the gate doesn't get in the way.
    for status in ("rejected", "pending", "rejected"):
        code, _, output = _invoke(["approve", epic_id, status])
        assert code == 0, output
        assert _merged_epic_approval(tmp_path, epic_id) == status


def test_approve_uses_temp_rename_in_same_dir(tmp_path, monkeypatch):
    """After approve, no stray .tmp files remain in the state/epics/ dir."""
    _create_project(tmp_path, monkeypatch)
    epic_id, _ = _make_epic_with_task()
    code, _, output = _invoke(["approve", epic_id, "rejected"])
    assert code == 0, output

    epics_state_dir = tmp_path / ".planctl" / "state" / "epics"
    stray = list(epics_state_dir.glob("*.tmp")) + list(epics_state_dir.glob("tmp*"))
    assert stray == [], f"atomic_write left tmp files behind: {stray}"


# ---------------------------------------------------------------------------
# (b) Round-trip preserves all unknown top-level fields
# ---------------------------------------------------------------------------


def test_approve_leaves_def_file_untouched(tmp_path, monkeypatch):
    """fn-732: approve does NOT rewrite the def file at all.

    The def file is byte-stable across an approve (approval moved to the
    sidecar), so unknown future keeper fields trivially survive AND the
    approval the def already carried is unchanged. The merged read picks up
    the new value from the sidecar.
    """
    _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _make_epic_with_task()

    # Inject unknown fields directly on the on-disk JSON.
    epic_path = tmp_path / ".planctl" / "epics" / f"{epic_id}.json"
    epic_data = json.loads(epic_path.read_text())
    epic_data["future_keeper_field"] = {"shape": "nested", "n": 42}
    epic_data["future_scalar"] = "opaque-value"
    epic_path.write_text(json.dumps(epic_data, indent=2, sort_keys=True) + "\n")
    epic_bytes_before = epic_path.read_bytes()

    task_path = tmp_path / ".planctl" / "tasks" / f"{task_id}.json"
    task_data = json.loads(task_path.read_text())
    task_data["future_task_field"] = ["a", "b", "c"]
    task_path.write_text(json.dumps(task_data, indent=2, sort_keys=True) + "\n")
    task_bytes_before = task_path.read_bytes()

    # Mutate approval through the CLI.  Use unguarded statuses so the fn-592
    # approve-gates don't fire.
    code, _, output = _invoke(["approve", epic_id, "rejected"])
    assert code == 0, output
    code, _, output = _invoke(["approve", epic_id, task_id, "rejected"])
    assert code == 0, output

    # Def files are byte-identical — approve never touched them.
    assert epic_path.read_bytes() == epic_bytes_before
    assert task_path.read_bytes() == task_bytes_before
    # Unknown fields trivially survived.
    epic_after = json.loads(epic_path.read_text())
    assert epic_after["future_keeper_field"] == {"shape": "nested", "n": 42}
    assert epic_after["future_scalar"] == "opaque-value"
    task_after = json.loads(task_path.read_text())
    assert task_after["future_task_field"] == ["a", "b", "c"]
    # Merged reads pick up the sidecar value.
    assert _merged_epic_approval(tmp_path, epic_id) == "rejected"
    assert _merged_task_approval(tmp_path, task_id) == "rejected"


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
        assert _merged_task_approval(tmp_path, task_id) == status


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
    assert _merged_epic_approval(tmp_path, epic_id) != "approved"


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
    assert _merged_epic_approval(tmp_path, epic_id) != "approved"


def test_approve_epic_refuses_when_any_task_not_approved(tmp_path, monkeypatch):
    """Gate: epic `approved` fails when at least one task isn't approved.

    fn-732: the gate reads each task's MERGED approval (sidecar > def >
    pending). t1's approval is in its sidecar; t2 is pending (no sidecar
    approval) — the gate must refuse, proving it reads the merged value.
    """
    _create_project(tmp_path, monkeypatch)
    epic_id, task_ids = _make_epic_with_tasks(n_tasks=2)
    t1, t2 = task_ids

    # Both tasks done; only t1 approved (via the sidecar).
    _force_task_done(tmp_path, t1)
    _force_task_done(tmp_path, t2)
    _force_task_approval(tmp_path, t1, "approved")
    # t2 stays pending.
    _force_epic_done(tmp_path, epic_id)

    code, _, output = _invoke(["approve", epic_id, "approved"])
    assert code != 0, output
    assert t2 in output
    assert "approved" in output.lower()
    assert _merged_epic_approval(tmp_path, epic_id) != "approved"


def test_approve_epic_succeeds_when_fully_clean(tmp_path, monkeypatch):
    """Gate happy path: epic done + every task done + every task approved → success.

    fn-732 keystone: every task's approval is in its SIDECAR (not the def
    file). The epic gate's merged read must resolve them all to "approved"
    and let the epic approve land on the epic sidecar.
    """
    _create_project(tmp_path, monkeypatch)
    epic_id, task_ids = _make_epic_with_tasks(n_tasks=3)

    for tid in task_ids:
        _force_task_done(tmp_path, tid)
        _force_task_approval(tmp_path, tid, "approved")
    _force_epic_done(tmp_path, epic_id)

    code, _, output = _invoke(["approve", epic_id, "approved"])
    assert code == 0, output
    assert _merged_epic_approval(tmp_path, epic_id) == "approved"


def test_approve_epic_rejected_unguarded_across_all_states(tmp_path, monkeypatch):
    """Gate carve-out: epic rejected/pending writes succeed in every state combo."""
    _create_project(tmp_path, monkeypatch)
    epic_id, task_ids = _make_epic_with_tasks(n_tasks=2)
    t1, t2 = task_ids

    # State combo 1: nothing done, nothing approved.
    for status in ("rejected", "pending"):
        code, _, output = _invoke(["approve", epic_id, status])
        assert code == 0, output
        assert _merged_epic_approval(tmp_path, epic_id) == status

    # State combo 2: epic done but tasks still mixed — rejected still fine.
    _force_task_done(tmp_path, t1)
    _force_epic_done(tmp_path, epic_id)
    for status in ("rejected", "pending"):
        code, _, output = _invoke(["approve", epic_id, status])
        assert code == 0, output
        assert _merged_epic_approval(tmp_path, epic_id) == status

    # State combo 3: everything ready for approval — rejected still allowed
    # (operator may want to flip an already-approvable epic into the reject
    # bucket without trying to approve it first).
    _force_task_done(tmp_path, t2)
    _force_task_approval(tmp_path, t1, "approved")
    _force_task_approval(tmp_path, t2, "approved")
    for status in ("rejected", "pending"):
        code, _, output = _invoke(["approve", epic_id, status])
        assert code == 0, output
        assert _merged_epic_approval(tmp_path, epic_id) == status


# ---------------------------------------------------------------------------
# Serializer form pinning — exact bytes documented for downstream keeperd
# ---------------------------------------------------------------------------


def test_serializer_form_is_indent2_sortkeys_trailing_newline(tmp_path, monkeypatch):
    """Pin the exact sidecar form so keeperd can match byte-for-byte:
    - indent=2 spaces
    - sort_keys=True (keys lexicographic)
    - trailing newline (single "\\n" after the closing "}")
    - UTF-8 encoding

    fn-732: approval now lands on the gitignored epic sidecar, so pin THAT
    file's form (the def file is no longer written by approve).
    """
    _create_project(tmp_path, monkeypatch)
    epic_id, _ = _make_epic_with_task()
    code, _, output = _invoke(["approve", epic_id, "rejected"])
    assert code == 0, output

    sidecar_path = tmp_path / ".planctl" / "state" / "epics" / f"{epic_id}.state.json"
    raw = sidecar_path.read_bytes()
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
    """approve emits a planctl_invocation payload with op=approve."""
    _create_project(tmp_path, monkeypatch)
    epic_id, _ = _make_epic_with_task()
    runner = CliRunner()
    result = runner.invoke(cli, ["approve", epic_id, "rejected"], env=_ENV)
    assert result.exit_code == 0, result.output
    assert '"planctl_invocation"' in result.output
    assert '"approve"' in result.output


def test_approve_envelope_is_runtime_state_only(tmp_path, monkeypatch):
    """fn-732: approve is runtime-state-only — NULL subject/files, no commit.

    Mirrors `claim`/`block`: the readonly invocation payload carries NULL
    `subject`/`files` so `auto_commit_from_invocation` no-ops. Asserts the
    envelope shape directly (the parsed invocation), the authoritative signal
    that no `chore(planctl): approve` commit lands.
    """
    _create_project(tmp_path, monkeypatch)
    epic_id, task_id = _make_epic_with_task()

    for args in (
        ["approve", epic_id, "rejected"],
        ["approve", epic_id, task_id, "rejected"],
    ):
        runner = CliRunner()
        result = runner.invoke(cli, args, env=_ENV)
        assert result.exit_code == 0, result.output
        # Find the planctl_invocation envelope line.
        pc = None
        for line in result.output.splitlines():
            line = line.strip()
            if line.startswith("{") and "planctl_invocation" in line:
                with contextlib.suppress(json.JSONDecodeError):
                    obj = json.loads(line)
                    if "planctl_invocation" in obj:
                        pc = obj["planctl_invocation"]
                        break
        assert pc is not None, f"no planctl_invocation in output:\n{result.output}"
        assert pc.get("op") == "approve"
        assert pc.get("subject") is None, "approve must carry NULL subject (no commit)"
        assert pc.get("files") is None, "approve must carry NULL files (no commit)"


@pytest.mark.real_git
def test_approve_lands_no_commit(planctl_git_repo):
    """fn-732 end-to-end: approve mutates only gitignored state, lands no commit.

    Uses the real-git fixture (auto-commit not mocked) so a stray
    `chore(planctl): approve` commit would show up. After an approve the
    repo's commit count must be unchanged.
    """
    from .conftest import _git_commit_count, seed_epic

    project = planctl_git_repo
    epic_id, _ = seed_epic(project, title="no-commit", n_tasks=1, env=_ENV)
    before = _git_commit_count(project)

    code, _, output = _invoke(["approve", epic_id, "rejected"])
    assert code == 0, output

    after = _git_commit_count(project)
    assert after == before, (
        f"approve must not land a commit (runtime-state-only): {before} -> {after}"
    )
    # The sidecar carries the value despite no commit.
    assert _merged_epic_approval(project, epic_id) == "rejected"


# ---------------------------------------------------------------------------
# Resolution ladder — merge_task_state / merge_epic_state (fn-732)
# ---------------------------------------------------------------------------


def test_merge_task_state_approval_ladder():
    """fn-732: sidecar > def > pending precedence for merged task approval."""
    from planctl.models import merge_task_state

    base = {"id": "fn-1-x.1", "epic": "fn-1-x", "title": "X"}

    # Rung 1: sidecar wins over def.
    merged = merge_task_state(
        {**base, "approval": "rejected"}, {"status": "done", "approval": "approved"}
    )
    assert merged["approval"] == "approved"

    # Rung 2: sidecar absent / no approval key → def fallback.
    merged = merge_task_state({**base, "approval": "rejected"}, {"status": "done"})
    assert merged["approval"] == "rejected"
    merged = merge_task_state({**base, "approval": "rejected"}, None)
    assert merged["approval"] == "rejected"

    # Rung 2b: sidecar approval null → def fallback (not the null).
    merged = merge_task_state(
        {**base, "approval": "rejected"}, {"status": "done", "approval": None}
    )
    assert merged["approval"] == "rejected"

    # Rung 3: absent everywhere → pending.
    merged = merge_task_state(base, {"status": "done"})
    assert merged["approval"] == "pending"
    merged = merge_task_state(base, None)
    assert merged["approval"] == "pending"


def test_merge_epic_state_approval_ladder():
    """fn-732: sidecar > def > pending precedence for merged epic approval."""
    from planctl.models import merge_epic_state

    base = {"id": "fn-1-x", "title": "X", "status": "done"}

    # Rung 1: sidecar wins over def.
    merged = merge_epic_state(
        {**base, "approval": "rejected"}, {"approval": "approved"}
    )
    assert merged["approval"] == "approved"

    # Rung 2: sidecar absent → def fallback.
    merged = merge_epic_state({**base, "approval": "rejected"}, None)
    assert merged["approval"] == "rejected"
    merged = merge_epic_state({**base, "approval": "rejected"}, {})
    assert merged["approval"] == "rejected"

    # Rung 3: absent everywhere → pending.
    merged = merge_epic_state(base, None)
    assert merged["approval"] == "pending"
    merged = merge_epic_state(base, {})
    assert merged["approval"] == "pending"


def test_load_epic_merges_sidecar_approval(tmp_path, monkeypatch):
    """api.load_epic resolves approval via the sidecar ladder (fn-732)."""
    from planctl import api
    from planctl.project import ProjectContext

    _create_project(tmp_path, monkeypatch)
    epic_id, _ = _make_epic_with_task()
    # No sidecar yet → pending.
    planctl_dir = tmp_path / ".planctl"
    ctx = ProjectContext(
        name=tmp_path.name,
        data_dir=planctl_dir,
        state_dir=planctl_dir / "state",
        project_path=tmp_path,
    )
    assert api.load_epic(ctx, epic_id)["approval"] == "pending"

    # Approve via the CLI (writes sidecar) → load_epic reflects it.
    code, _, output = _invoke(["approve", epic_id, "rejected"])
    assert code == 0, output
    assert api.load_epic(ctx, epic_id)["approval"] == "rejected"


# ---------------------------------------------------------------------------
# CLI surface: set-approval is gone from the registered command list.
# ---------------------------------------------------------------------------


def test_set_approval_subcommand_removed():
    """The old `set-approval` subcommand is no longer registered on the CLI."""
    assert "set-approval" not in cli.commands
    assert "approve" in cli.commands


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

    # fn-732: approval lands on proj_b's task sidecar, not its def file.
    assert _merged_task_approval(proj_b, task_id) == "approved"


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

    # fn-732: approval lands on proj_b's epic sidecar, not its def file.
    assert _merged_epic_approval(proj_b, epic_id) == "approved"


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
