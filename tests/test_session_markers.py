"""Tests for the session-marker layer (``planctl.session_markers``) + its wiring.

Two halves:

* **Helper unit tests** — write / clear / clear-if-mismatch / read / stale-unlink
  / no-env-no-op / io-error-swallow against a tmp marker dir. Pure filesystem,
  fast bucket.
* **Per-verb integration tests** — drive each of the six wired verbs and assert
  the marker is present (claim, worker resume, close-preflight) or absent (done,
  block, close-finalize) afterwards, plus the no-env-no-op contract.

The autouse ``_isolated_session_markers`` conftest fixture already redirects the
marker dir to a throwaway tmp dir; tests that need to inspect that dir
re-monkeypatch ``session_markers._sessions_dir`` to a path they control.
"""

from __future__ import annotations

import json
import os
import time
from types import SimpleNamespace

import pytest
from planctl import session_markers

from .conftest import run_cli, seed_state

_SESSION = "test-marker-session"


@pytest.fixture
def marker_dir(tmp_path, monkeypatch):
    """Redirect the marker dir to a controlled tmp dir and pin the session id."""
    d = tmp_path / "sessions"
    monkeypatch.setattr(session_markers, "_sessions_dir", lambda: d)
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", _SESSION)
    return d


def _read_raw(marker_dir, session_id=_SESSION):
    return json.loads((marker_dir / f"{session_id}.json").read_text(encoding="utf-8"))


# --------------------------------------------------------------------------
# helper unit tests
# --------------------------------------------------------------------------


def test_write_work_marker_schema(marker_dir):
    """write_work_marker emits the schema_version-1 work shape."""
    session_markers.write_work_marker("fn-9-x.1")
    rec = _read_raw(marker_dir)
    assert rec == {
        "schema_version": 1,
        "session_id": _SESSION,
        "kind": "work",
        "task_id": "fn-9-x.1",
        "created_at": rec["created_at"],
    }
    assert isinstance(rec["created_at"], str) and rec["created_at"]


def test_write_close_marker_schema(marker_dir):
    """write_close_marker emits the schema_version-1 close shape with epic_id."""
    session_markers.write_close_marker("fn-9-x")
    rec = _read_raw(marker_dir)
    assert rec["schema_version"] == 1
    assert rec["session_id"] == _SESSION
    assert rec["kind"] == "close"
    assert rec["epic_id"] == "fn-9-x"
    assert "task_id" not in rec


def test_clear_work_marker_matching(marker_dir):
    """clear_work_marker unlinks the marker when the task_id matches."""
    session_markers.write_work_marker("fn-9-x.1")
    assert (marker_dir / f"{_SESSION}.json").exists()
    session_markers.clear_work_marker("fn-9-x.1")
    assert not (marker_dir / f"{_SESSION}.json").exists()


def test_clear_work_marker_mismatch_left_intact(marker_dir):
    """A clear naming a different task leaves the marker on disk."""
    session_markers.write_work_marker("fn-9-x.1")
    session_markers.clear_work_marker("fn-9-x.2")
    assert (marker_dir / f"{_SESSION}.json").exists()
    assert _read_raw(marker_dir)["task_id"] == "fn-9-x.1"


def test_clear_close_marker_matching(marker_dir):
    session_markers.write_close_marker("fn-9-x")
    session_markers.clear_close_marker("fn-9-x")
    assert not (marker_dir / f"{_SESSION}.json").exists()


def test_clear_close_marker_mismatch_left_intact(marker_dir):
    session_markers.write_close_marker("fn-9-x")
    session_markers.clear_close_marker("fn-9-other")
    assert (marker_dir / f"{_SESSION}.json").exists()


def test_clear_kind_crosswise_is_mismatch(marker_dir):
    """A close-marker is not cleared by a work-clear (different id field)."""
    session_markers.write_close_marker("fn-9-x")
    session_markers.clear_work_marker("fn-9-x")
    assert (marker_dir / f"{_SESSION}.json").exists()


def test_read_marker_roundtrip(marker_dir):
    session_markers.write_work_marker("fn-9-x.1")
    rec = session_markers.read_marker(_SESSION)
    assert rec is not None and rec["task_id"] == "fn-9-x.1"
    assert (marker_dir / f"{_SESSION}.json").exists()


def test_read_marker_missing_returns_none():
    assert session_markers.read_marker("no-such-session") is None


def test_read_marker_unlinks_stale(marker_dir):
    """A marker older than 7 days is unlinked and read returns None."""
    session_markers.write_work_marker("fn-9-x.1")
    path = marker_dir / f"{_SESSION}.json"
    old = time.time() - (8 * 24 * 60 * 60)
    os.utime(path, (old, old))
    assert session_markers.read_marker(_SESSION) is None
    assert not path.exists()


def test_read_marker_fresh_kept(marker_dir):
    """A marker just under the 7-day window survives a read."""
    session_markers.write_work_marker("fn-9-x.1")
    path = marker_dir / f"{_SESSION}.json"
    recent = time.time() - (6 * 24 * 60 * 60)
    os.utime(path, (recent, recent))
    assert session_markers.read_marker(_SESSION) is not None
    assert path.exists()


def test_read_marker_corrupt_unlinks(marker_dir):
    """An unparseable marker file is treated as absent and unlinked."""
    marker_dir.mkdir(parents=True, exist_ok=True)
    path = marker_dir / f"{_SESSION}.json"
    path.write_text("{not json", encoding="utf-8")
    assert session_markers.read_marker(_SESSION) is None


def test_read_marker_non_dict_unlinks(marker_dir):
    marker_dir.mkdir(parents=True, exist_ok=True)
    path = marker_dir / f"{_SESSION}.json"
    path.write_text("[1, 2, 3]", encoding="utf-8")
    assert session_markers.read_marker(_SESSION) is None
    assert not path.exists()


def test_no_env_is_noop_for_every_helper(tmp_path, monkeypatch):
    """With CLAUDE_CODE_SESSION_ID unset, no helper writes / reads / errors."""
    d = tmp_path / "sessions"
    monkeypatch.setattr(session_markers, "_sessions_dir", lambda: d)
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)

    session_markers.write_work_marker("fn-9-x.1")
    session_markers.write_close_marker("fn-9-x")
    session_markers.clear_work_marker("fn-9-x.1")
    session_markers.clear_close_marker("fn-9-x")
    # No directory created, no file written, no exception.
    assert not d.exists()


def test_write_io_error_swallowed(marker_dir, monkeypatch):
    """A filesystem error during write never propagates out of the helper."""

    def _boom(*_a, **_k):
        raise OSError("disk full")

    monkeypatch.setattr(session_markers.Path, "mkdir", _boom)
    # Must not raise.
    session_markers.write_work_marker("fn-9-x.1")
    assert not (marker_dir / f"{_SESSION}.json").exists()


def test_clear_io_error_swallowed(marker_dir, monkeypatch):
    """A filesystem error during clear's unlink never propagates."""
    session_markers.write_work_marker("fn-9-x.1")

    def _boom(_self, *_a, **_k):
        raise OSError("read-only fs")

    monkeypatch.setattr(session_markers.Path, "unlink", _boom)
    # Must not raise even though unlink fails.
    session_markers.clear_work_marker("fn-9-x.1")
    assert (marker_dir / f"{_SESSION}.json").exists()


# --------------------------------------------------------------------------
# per-verb integration tests
# --------------------------------------------------------------------------


@pytest.fixture
def verb_marker_dir(tmp_path, monkeypatch):
    """Marker dir + pinned session id for verb-driving integration tests.

    Distinct from ``marker_dir`` only in that verb tests build their own
    ``.planctl/`` tree under ``tmp_path`` and chdir into it, so the marker dir
    is parked under a sibling path the verb never touches.
    """
    d = tmp_path / "_marker_sessions"
    monkeypatch.setattr(session_markers, "_sessions_dir", lambda: d)
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", _SESSION)
    return d


def _marker_present(d):
    return (d / f"{_SESSION}.json").exists()


@pytest.mark.real_roots
def test_claim_success_writes_work_marker(tmp_path, monkeypatch, verb_marker_dir):
    """A successful claim writes a work marker naming the task."""
    _, task_ids = seed_state(tmp_path, epic_id="fn-1-marker", n_tasks=1)
    task_id = task_ids[0]

    # claim resolves the owning project via roots discovery, not cwd — point a
    # controlled root at the seeded project (the test_claim.py symlink pattern).
    root = tmp_path / "_root"
    root.mkdir()
    (root / tmp_path.name).symlink_to(tmp_path, target_is_directory=True)
    cfg = tmp_path / "_roots.yaml"
    cfg.write_text(f"roots:\n  - {root}\n", encoding="utf-8")
    monkeypatch.setattr("planctl.config.CONFIG_PATH", cfg)
    monkeypatch.chdir(tmp_path)

    result = run_cli(["claim", task_id])
    assert result.exit_code == 0, result.output
    assert _marker_present(verb_marker_dir)
    assert _read_raw(verb_marker_dir)["task_id"] == task_id
    assert _read_raw(verb_marker_dir)["kind"] == "work"


def test_claim_typed_error_writes_nothing(tmp_path, monkeypatch, verb_marker_dir):
    """A BAD_TASK_ID claim error path writes no marker."""
    monkeypatch.chdir(tmp_path)
    result = run_cli(["claim", "not-a-task-id"])
    assert result.exit_code != 0
    assert not _marker_present(verb_marker_dir)


def test_worker_resume_success_writes_work_marker(
    tmp_path, monkeypatch, verb_marker_dir
):
    """worker resume (success) writes the work marker."""
    import planctl.run_worker_resume as rwr

    _, task_ids = seed_state(tmp_path, epic_id="fn-2-marker", n_tasks=1)
    task_id = task_ids[0]
    monkeypatch.chdir(tmp_path)

    rc = rwr.run(SimpleNamespace(task_id=task_id))
    assert rc == 0
    assert _marker_present(verb_marker_dir)
    assert _read_raw(verb_marker_dir)["task_id"] == task_id


def test_done_clears_matching_work_marker(tmp_path, monkeypatch, verb_marker_dir):
    """done clears the work marker when it names the task being completed."""
    import planctl.run_done as rd

    _, task_ids = seed_state(tmp_path, epic_id="fn-3-marker", n_tasks=1)
    task_id = task_ids[0]
    monkeypatch.chdir(tmp_path)

    # Establish an in_progress + matching marker (write directly; claim's roots
    # resolution is exercised in its own test).
    session_markers.write_work_marker(task_id)
    from planctl.store import LocalFileStateStore
    from planctl.project import resolve_project

    store = LocalFileStateStore(resolve_project().state_dir)
    store.save_runtime(
        task_id,
        {"status": "in_progress", "assignee": os.environ["PLANCTL_ACTOR"]},
    )
    assert _marker_present(verb_marker_dir)

    rc = rd.run(
        SimpleNamespace(task_id=task_id, summary="done", evidence=None, force=False)
    )
    assert rc == 0
    assert not _marker_present(verb_marker_dir)


def test_done_leaves_mismatched_marker(tmp_path, monkeypatch, verb_marker_dir):
    """done on task .1 leaves a marker that names task .2 intact."""
    import planctl.run_done as rd
    from planctl.project import resolve_project
    from planctl.store import LocalFileStateStore

    _, task_ids = seed_state(tmp_path, epic_id="fn-4-marker", n_tasks=2)
    monkeypatch.chdir(tmp_path)

    session_markers.write_work_marker(task_ids[1])  # marker names .2
    store = LocalFileStateStore(resolve_project().state_dir)
    store.save_runtime(
        task_ids[0],
        {"status": "in_progress", "assignee": os.environ["PLANCTL_ACTOR"]},
    )

    rc = rd.run(
        SimpleNamespace(task_id=task_ids[0], summary="done", evidence=None, force=False)
    )
    assert rc == 0
    assert _marker_present(verb_marker_dir)
    assert _read_raw(verb_marker_dir)["task_id"] == task_ids[1]


def test_block_clears_matching_work_marker(tmp_path, monkeypatch, verb_marker_dir):
    import planctl.run_block as rb
    from planctl.project import resolve_project
    from planctl.store import LocalFileStateStore

    _, task_ids = seed_state(tmp_path, epic_id="fn-5-marker", n_tasks=1)
    task_id = task_ids[0]
    monkeypatch.chdir(tmp_path)

    session_markers.write_work_marker(task_id)
    store = LocalFileStateStore(resolve_project().state_dir)
    store.save_runtime(
        task_id, {"status": "in_progress", "assignee": os.environ["PLANCTL_ACTOR"]}
    )

    rc = rb.run(SimpleNamespace(task_id=task_id, reason="stuck", reason_file=None))
    assert rc == 0
    assert not _marker_present(verb_marker_dir)


def test_close_preflight_failure_writes_no_close_marker(
    tmp_path, monkeypatch, verb_marker_dir
):
    """A not-ready epic (tasks not all done) fails preflight → no close marker."""
    import planctl.run_close_preflight as rcp

    epic_id, _ = seed_state(tmp_path, epic_id="fn-6-marker", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    # NOT_READY (tasks not done) → _emit_preflight_error → sys.exit(1) before the
    # marker write. The exit proves the failure path; no marker must remain.
    with pytest.raises(SystemExit):
        rcp.run(SimpleNamespace(epic_id=epic_id, project=None))
    assert not _marker_present(verb_marker_dir)


@pytest.mark.parametrize(
    "outcome",
    list(
        __import__("planctl.run_close_finalize", fromlist=["CloseOutcome"]).CloseOutcome
    ),
)
def test_close_finalize_clears_marker_on_every_outcome(
    tmp_path, verb_marker_dir, outcome
):
    """_emit_outcome (the single chokepoint for all four CloseOutcomes) clears
    the close marker when it names the epic."""
    import io
    from contextlib import redirect_stdout

    import planctl.run_close_finalize as rcf

    epic_id = "fn-7-marker"
    session_markers.write_close_marker(epic_id)
    assert _marker_present(verb_marker_dir)

    ctx = SimpleNamespace(project_path=tmp_path)
    with redirect_stdout(io.StringIO()):
        rc = rcf._emit_outcome(outcome, epic_id, ctx)
    assert rc == 0
    assert not _marker_present(verb_marker_dir)


def test_close_finalize_leaves_mismatched_marker(tmp_path, verb_marker_dir):
    """A close marker naming a different epic survives close-finalize."""
    import io
    from contextlib import redirect_stdout

    import planctl.run_close_finalize as rcf

    session_markers.write_close_marker("fn-7-other")
    ctx = SimpleNamespace(project_path=tmp_path)
    with redirect_stdout(io.StringIO()):
        rcf._emit_outcome(rcf.CloseOutcome.CLOSED_CLEAN, "fn-7-marker", ctx)
    assert _marker_present(verb_marker_dir)
    assert _read_raw(verb_marker_dir)["epic_id"] == "fn-7-other"
