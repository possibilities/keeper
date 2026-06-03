"""SQLite-backed manual-approval-gate stamps (fn-488).

Replaces the tracked-JSON ``worker_acked_at`` / ``closer_acked_at`` fields
introduced by fn-386.  The original design landed ack stamps on the tracked
task/epic JSON so the plans-namespace broadcast carried them, but the
plug-fired ack writes do not trigger the hookctl ``planctl-mutation``
post-hook (the hook only fires on PostToolUse:Bash, and plug-side writes
bypass it).  The net effect was a long tail of orphaned acks that needed
rescue commits (``task-ack`` appeared 1× in 500 commits over a 36 hour
sample).  Moving the ack stamps to a gitignored SQLite at
``<repo>/.planctl/state/acks.db`` eliminates the rescue-commit class
entirely — there is nothing in the tracked tree to commit.

The plug-side bundle builder is responsible for merging the ack values
back into the broadcast ``epic`` / ``tasks`` dicts so existing
``derive_*_runtime_status`` consumers (planctl watch and other board
readers) keep reading the same field names from the same dict shape.

Module surface:

- :func:`save_task_ack(task_id, ts, *, repo_root)` — UPSERT a task ack.
- :func:`save_epic_ack(epic_id, ts, *, repo_root)` — UPSERT an epic ack.
- :func:`get_task_ack(task_id, *, repo_root) -> str | None` — SELECT one.
- :func:`get_epic_ack(epic_id, *, repo_root) -> str | None` — SELECT one.
- :func:`clear_task_ack(task_id, *, repo_root)` — DELETE one (used by
  ``planctl task reset``).
- :func:`all_task_acks(*, repo_root) -> dict[str, str]` — bulk read; used
  by the plug bundle builder + the migration script.
- :func:`all_epic_acks(*, repo_root) -> dict[str, str]` — bulk read; ditto.

All writes use SQLite WAL mode and UPSERT semantics (idempotent on
re-call — every ack write overwrites the timestamp, mirroring the
pre-fn-488 tracked-JSON contract).  The schema is created on first
write; opening a database that does not exist for a read returns the
empty result (no auto-create on read — keeps the cold-start hot path
free of accidental disk side effects).

Plug-restart on clean machine: a fresh checkout has no
``acks.db``.  Bundle reads return ``None`` for every ack.  The next
``planctl task ack`` / ``epic ack`` from that machine fires a
first-set transition that observers will treat as new — accepted per
fn-488 design (single-user repo, cross-machine ack visibility not
required).
"""

from __future__ import annotations

import sqlite3
from pathlib import Path


def _db_path(repo_root: Path | str) -> Path:
    """Return the absolute path to the acks database for *repo_root*.

    Always ``<repo_root>/.planctl/state/acks.db``.  The directory is
    created on demand by :func:`_open_for_write`; reads do not create
    the directory.
    """
    return Path(repo_root) / ".planctl" / "state" / "acks.db"


def _ensure_schema(conn: sqlite3.Connection) -> None:
    """Create the two ack tables and enable WAL.

    Idempotent — ``CREATE TABLE IF NOT EXISTS`` runs every open, which
    is cheap (it's a no-op when the tables already exist).  WAL is set
    on every open too; SQLite caches the mode after the first set, so
    repeated ``PRAGMA journal_mode=WAL`` calls are also effectively
    free.
    """
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS task_acks ("
        "  task_id TEXT PRIMARY KEY,"
        "  acked_at TEXT NOT NULL"
        ")"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS epic_acks ("
        "  epic_id TEXT PRIMARY KEY,"
        "  acked_at TEXT NOT NULL"
        ")"
    )


def _open_for_write(repo_root: Path | str) -> sqlite3.Connection:
    """Open (or create) the acks DB for write.

    Creates the parent ``.planctl/state/`` directory if absent (mode
    inherited from umask — the surrounding directory tree is already
    user-private).  Runs :func:`_ensure_schema` once before returning.
    Caller owns ``conn.close()``.
    """
    path = _db_path(repo_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    _ensure_schema(conn)
    return conn


def _open_for_read(repo_root: Path | str) -> sqlite3.Connection | None:
    """Open the acks DB for read, or return ``None`` when the file is absent.

    Reads NEVER auto-create the DB — the cold-start path on a fresh
    checkout must stay side-effect free so a bare ``planctl watch`` or
    ``planctl show`` on a freshly cloned repo does not splatter a 0-row
    SQLite file into the gitignored state dir.  Callers treat ``None``
    as "no acks recorded yet" and return their empty-result default.
    """
    path = _db_path(repo_root)
    if not path.exists():
        return None
    return sqlite3.connect(str(path))


def save_task_ack(task_id: str, ts: str, *, repo_root: Path | str) -> None:
    """UPSERT a task ack timestamp.

    Idempotent on re-call — every write overwrites ``acked_at``.  The
    timestamp value is the caller's responsibility (typically
    ``now_iso()`` from ``planctl.store``).
    """
    conn = _open_for_write(repo_root)
    try:
        conn.execute(
            "INSERT INTO task_acks(task_id, acked_at) VALUES (?, ?) "
            "ON CONFLICT(task_id) DO UPDATE SET acked_at=excluded.acked_at",
            (task_id, ts),
        )
        conn.commit()
    finally:
        conn.close()


def save_epic_ack(epic_id: str, ts: str, *, repo_root: Path | str) -> None:
    """UPSERT an epic ack timestamp.  See :func:`save_task_ack`."""
    conn = _open_for_write(repo_root)
    try:
        conn.execute(
            "INSERT INTO epic_acks(epic_id, acked_at) VALUES (?, ?) "
            "ON CONFLICT(epic_id) DO UPDATE SET acked_at=excluded.acked_at",
            (epic_id, ts),
        )
        conn.commit()
    finally:
        conn.close()


def get_task_ack(task_id: str, *, repo_root: Path | str) -> str | None:
    """Return the stored ``acked_at`` for *task_id*, or ``None`` if absent.

    ``None`` covers both the "DB doesn't exist yet" path and the
    "DB exists but no row for this id" path — callers cannot
    distinguish, and don't need to.
    """
    conn = _open_for_read(repo_root)
    if conn is None:
        return None
    try:
        row = conn.execute(
            "SELECT acked_at FROM task_acks WHERE task_id = ?", (task_id,)
        ).fetchone()
        return row[0] if row is not None else None
    finally:
        conn.close()


def get_epic_ack(epic_id: str, *, repo_root: Path | str) -> str | None:
    """Return the stored ``acked_at`` for *epic_id*, or ``None`` if absent."""
    conn = _open_for_read(repo_root)
    if conn is None:
        return None
    try:
        row = conn.execute(
            "SELECT acked_at FROM epic_acks WHERE epic_id = ?", (epic_id,)
        ).fetchone()
        return row[0] if row is not None else None
    finally:
        conn.close()


def clear_task_ack(task_id: str, *, repo_root: Path | str) -> None:
    """DELETE the ack row for *task_id*.  No-op when the row (or DB) is absent.

    Used by ``planctl task reset`` to release the gate alongside the
    cleared ``worker_done_at``.  Same idempotent semantic as the
    pre-fn-488 tracked-JSON ``= None`` write.
    """
    conn = _open_for_read(repo_root)
    if conn is None:
        return
    try:
        conn.execute("DELETE FROM task_acks WHERE task_id = ?", (task_id,))
        conn.commit()
    finally:
        conn.close()


def all_task_acks(*, repo_root: Path | str) -> dict[str, str]:
    """Return ``{task_id: acked_at}`` for every recorded task ack.

    Bulk read for the plug bundle builder (one DB open per
    ``_compute_plans_value`` call rather than N per-task SELECTs) and
    the migration script.  Returns ``{}`` when the DB is absent.
    """
    conn = _open_for_read(repo_root)
    if conn is None:
        return {}
    try:
        return {
            row[0]: row[1]
            for row in conn.execute("SELECT task_id, acked_at FROM task_acks")
        }
    finally:
        conn.close()


def all_epic_acks(*, repo_root: Path | str) -> dict[str, str]:
    """Return ``{epic_id: acked_at}`` for every recorded epic ack.

    Bulk read for the plug bundle builder + the migration script.  See
    :func:`all_task_acks`.
    """
    conn = _open_for_read(repo_root)
    if conn is None:
        return {}
    try:
        return {
            row[0]: row[1]
            for row in conn.execute("SELECT epic_id, acked_at FROM epic_acks")
        }
    finally:
        conn.close()
