"""Tests for the new planctl.acks SQLite-backed ack store (fn-488)."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from planctl import acks


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A bare repo root — no .planctl/ dir yet (read path tests need this)."""
    return tmp_path


def _db_present(repo_root: Path) -> bool:
    return (repo_root / ".planctl" / "state" / "acks.db").exists()


def test_get_returns_none_when_db_absent(repo: Path) -> None:
    """Cold-start path: reads return None and do NOT auto-create the DB."""
    assert acks.get_task_ack("fn-1.1", repo_root=repo) is None
    assert acks.get_epic_ack("fn-1", repo_root=repo) is None
    assert acks.all_task_acks(repo_root=repo) == {}
    assert acks.all_epic_acks(repo_root=repo) == {}
    assert not _db_present(repo), (
        "reads must not create acks.db; the cold-start "
        "path on a fresh checkout must stay side-effect free"
    )


def test_clear_is_noop_when_db_absent(repo: Path) -> None:
    """`task reset` against a never-written ack store must not blow up."""
    acks.clear_task_ack("fn-1.1", repo_root=repo)  # must not raise
    assert not _db_present(repo)


def test_save_task_ack_creates_db_and_round_trips(repo: Path) -> None:
    acks.save_task_ack("fn-1.1", "2026-05-15T10:00:00Z", repo_root=repo)
    assert _db_present(repo)
    assert acks.get_task_ack("fn-1.1", repo_root=repo) == "2026-05-15T10:00:00Z"
    assert acks.all_task_acks(repo_root=repo) == {"fn-1.1": "2026-05-15T10:00:00Z"}


def test_save_epic_ack_creates_db_and_round_trips(repo: Path) -> None:
    acks.save_epic_ack("fn-1", "2026-05-15T10:01:00Z", repo_root=repo)
    assert _db_present(repo)
    assert acks.get_epic_ack("fn-1", repo_root=repo) == "2026-05-15T10:01:00Z"
    assert acks.all_epic_acks(repo_root=repo) == {"fn-1": "2026-05-15T10:01:00Z"}


def test_save_is_idempotent_upserts_timestamp(repo: Path) -> None:
    """Re-acking the same id overwrites the timestamp without erroring."""
    acks.save_task_ack("fn-1.1", "2026-05-15T10:00:00Z", repo_root=repo)
    acks.save_task_ack("fn-1.1", "2026-05-15T11:00:00Z", repo_root=repo)
    assert acks.get_task_ack("fn-1.1", repo_root=repo) == "2026-05-15T11:00:00Z"

    acks.save_epic_ack("fn-1", "2026-05-15T10:01:00Z", repo_root=repo)
    acks.save_epic_ack("fn-1", "2026-05-15T11:01:00Z", repo_root=repo)
    assert acks.get_epic_ack("fn-1", repo_root=repo) == "2026-05-15T11:01:00Z"


def test_clear_removes_only_target_row(repo: Path) -> None:
    acks.save_task_ack("fn-1.1", "2026-05-15T10:00:00Z", repo_root=repo)
    acks.save_task_ack("fn-1.2", "2026-05-15T11:00:00Z", repo_root=repo)
    acks.clear_task_ack("fn-1.1", repo_root=repo)
    assert acks.get_task_ack("fn-1.1", repo_root=repo) is None
    assert acks.get_task_ack("fn-1.2", repo_root=repo) == "2026-05-15T11:00:00Z"


def test_clear_unknown_id_is_noop(repo: Path) -> None:
    """`clear_task_ack` on a never-stamped id is harmless — same semantic as the
    pre-fn-488 ``= None`` tracked-JSON write."""
    acks.save_task_ack("fn-1.1", "2026-05-15T10:00:00Z", repo_root=repo)
    acks.clear_task_ack("fn-1.999", repo_root=repo)  # must not raise
    assert acks.get_task_ack("fn-1.1", repo_root=repo) == "2026-05-15T10:00:00Z"


def test_task_and_epic_acks_share_db_but_separate_tables(repo: Path) -> None:
    """One id used by both surfaces shouldn't collide — separate tables."""
    acks.save_task_ack("fn-1", "2026-05-15T10:00:00Z", repo_root=repo)
    acks.save_epic_ack("fn-1", "2026-05-15T11:00:00Z", repo_root=repo)
    assert acks.get_task_ack("fn-1", repo_root=repo) == "2026-05-15T10:00:00Z"
    assert acks.get_epic_ack("fn-1", repo_root=repo) == "2026-05-15T11:00:00Z"


def test_db_lives_under_planctl_state(repo: Path) -> None:
    """Sanity-check the on-disk location — it must be inside `.planctl/state/`
    which is gitignored, NOT inside the tracked `.planctl/epics` or
    `.planctl/tasks` trees."""
    acks.save_task_ack("fn-1.1", "2026-05-15T10:00:00Z", repo_root=repo)
    db = repo / ".planctl" / "state" / "acks.db"
    assert db.exists()
    assert db.is_file()


def test_db_is_wal_mode(repo: Path) -> None:
    """WAL mode is set on every open — confirm the schema is applied."""
    acks.save_task_ack("fn-1.1", "2026-05-15T10:00:00Z", repo_root=repo)
    db = repo / ".planctl" / "state" / "acks.db"
    conn = sqlite3.connect(str(db))
    try:
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        assert mode.lower() == "wal"
    finally:
        conn.close()


def test_string_repo_root_argument(repo: Path) -> None:
    """`repo_root=` accepts both Path and str — `_db_path` Path-coerces."""
    acks.save_task_ack("fn-1.1", "2026-05-15T10:00:00Z", repo_root=str(repo))
    assert acks.get_task_ack("fn-1.1", repo_root=str(repo)) == "2026-05-15T10:00:00Z"
