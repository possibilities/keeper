"""Public API: which dirty files is a session on the hook for?

``get_session_dirty_files(session_id, cwd)`` is the one function consumers
call (``jobctl commit-work`` and friends).  It reads keeper's
``file_attributions`` and ``git_status`` projections from ``keeper.db``
read-only and returns the session's currently-dirty, not-since-committed
files grouped by repo.

Attribution rule (mirrors the reducer's discharge semantic): a session is
on the hook for a file iff it has a mutation row whose ``last_commit_at`` is
NULL or older than ``last_mutation_at`` — editing puts you on the hook,
committing what you edited takes you off.  We additionally intersect against
``git_status.dirty_files`` so a file that was edited then reverted (still
undischarged, but no longer dirty) does not surface.

The import graph is stdlib-only (``sqlite3``, ``json``, ``os``,
``pathlib``) — ``commit-work`` shells out to git repeatedly, so this module
must not add cold-start weight.
"""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

# keeper schema versions this reader understands.  keeper tracks its schema in
# a ``meta`` key/value row — ``SELECT value FROM meta WHERE key='schema_version'``
# — NOT ``PRAGMA user_version`` (which keeper leaves at 0).  The
# ``file_attributions`` / ``git_status`` shape this reader depends on landed in
# v31 (fn-633); v32 (fn-634 ``default_visible``) is additive and doesn't touch
# it; v33 (fn-639 ``profiles``) is additive and doesn't touch it; v34
# (fn-637 ``resolved_epic_deps`` on epics) is additive and doesn't touch it;
# v35 (fn-642 ``usage``+``profiles`` rate-limit colocation) is additive and
# touches only ``usage`` / ``profiles`` (keeper-py reads neither); v36 (fn-642
# ``jobs.profile_name``) is an additive nullable column on ``jobs`` and doesn't
# touch the file-attribution shape; v37 (fn-643 ``dead_letters`` operational
# sidecar table + index) is additive and touches neither; v38 (fn-645 usage
# envelope status / subscription / error axes) adds nullable columns to
# ``usage`` only (keeper-py reads neither ``usage`` nor ``profiles``).
# Bump this set when a keeper schema change alters those tables.
SUPPORTED_SCHEMA_VERSIONS = frozenset({31, 32, 33, 34, 35, 36, 37, 38})


class KeeperError(Exception):
    """Base class for keeper-py failures."""


class KeeperDBMissing(KeeperError):
    """``keeper.db`` does not exist — the daemon never ran on this host."""


class KeeperSchemaError(KeeperError):
    """``keeper.db`` schema version is outside the supported set.

    Raised loud rather than returning wrong data: a schema the reader does
    not understand may have moved columns the attribution query depends on.
    """


def _resolve_db_path() -> Path:
    """Resolve ``keeper.db`` the same way keeper's ``resolveDbPath`` does.

    ``KEEPER_DB`` env var wins (tests, inspect tooling); otherwise the
    ``~/.local/state/keeper/keeper.db`` default.  Kept byte-identical to
    ``src/db.ts`` so the reader and the daemon never disagree on which file
    is canonical.
    """
    override = os.environ.get("KEEPER_DB")
    if override:
        return Path(override)
    return Path.home() / ".local" / "state" / "keeper" / "keeper.db"


def _open_readonly(path: Path) -> sqlite3.Connection:
    """Open *path* read-only with the consumer pragmas keeper sanctions.

    ``mode=ro`` fails fast if the file is absent and forbids writes;
    ``query_only`` is engine-level defense-in-depth; ``busy_timeout`` lets a
    reader wait out a WAL checkpoint instead of erroring with SQLITE_BUSY.
    We never touch ``journal_mode`` (the producer owns it) and never use
    ``immutable=1`` / ``nolock=1`` (keeper writes WAL frames live).
    """
    if not path.exists():
        raise KeeperDBMissing(f"keeper DB not found at {path}")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.execute("PRAGMA query_only = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def _check_schema(conn: sqlite3.Connection) -> None:
    """Raise ``KeeperSchemaError`` unless the keeper schema is supported.

    keeper stores its version as a ``meta`` key/value row (``value`` is TEXT),
    read the same way ``src/db.ts`` reads it.
    """
    try:
        row = conn.execute(
            "SELECT value FROM meta WHERE key = 'schema_version'"
        ).fetchone()
    except sqlite3.Error as exc:
        raise KeeperSchemaError(f"keeper DB has no readable meta row: {exc}") from exc
    if row is None:
        raise KeeperSchemaError("keeper DB has no meta schema_version row")
    try:
        version = int(row[0])
    except (TypeError, ValueError) as exc:
        raise KeeperSchemaError(
            f"keeper schema_version is not an integer: {row[0]!r}"
        ) from exc
    if version not in SUPPORTED_SCHEMA_VERSIONS:
        raise KeeperSchemaError(
            f"keeper DB schema v{version} is not supported by this keeper-py "
            f"(supports {sorted(SUPPORTED_SCHEMA_VERSIONS)}); upgrade keeper-py"
        )


def _dirty_paths_by_repo(conn: sqlite3.Connection) -> dict[str, set[str]]:
    """Return ``{project_dir: {dirty repo-relative path, ...}}`` from git_status.

    Each ``git_status.dirty_files`` cell is a JSON array of
    ``{path, xy, mtime_ms, attributions, ...}`` objects; we keep only the
    repo-relative ``path`` strings.  A malformed cell folds to an empty set
    for that repo (defensive — never raise on a single bad row).
    """
    out: dict[str, set[str]] = {}
    for project_dir, dirty_files in conn.execute(
        "SELECT project_dir, dirty_files FROM git_status"
    ):
        paths: set[str] = set()
        try:
            for entry in json.loads(dirty_files):
                p = entry.get("path") if isinstance(entry, dict) else None
                if isinstance(p, str) and p:
                    paths.add(p)
        except (ValueError, TypeError, AttributeError):
            paths = set()
        out[project_dir] = paths
    return out


def _resolve_cwd_repo(cwd: str, repos: list[str]) -> str | None:
    """Return the repo in *repos* that owns *cwd* (longest matching prefix).

    A repo owns *cwd* when *cwd* equals it or is a subdirectory of it.  The
    longest match wins so a nested checkout resolves to the inner repo, not
    an ancestor.
    """
    cwd_norm = cwd.rstrip("/")
    best: str | None = None
    for repo in repos:
        repo_norm = repo.rstrip("/")
        if cwd_norm == repo_norm or cwd_norm.startswith(repo_norm + "/"):
            if best is None or len(repo_norm) > len(best.rstrip("/")):
                best = repo
    return best


def get_session_dirty_files(session_id: str, cwd: str) -> dict:
    """Return the files *session_id* is on the hook for, grouped by repo.

    Shape::

        {
          "files_by_repo": {"<repo abs path>": ["<repo-relative path>", ...]},
          "cwd_repo": "<repo abs path>" | None,
        }

    A file qualifies when the session has an undischarged mutation row for it
    (``last_commit_at IS NULL OR last_commit_at < last_mutation_at``) AND the
    file is currently dirty per ``git_status``.  ``.planctl/`` exclusion is
    NOT done here — that is the caller's partition (jobctl routes ``.planctl``
    through the planctl-commit hook).

    Raises ``KeeperDBMissing`` if ``keeper.db`` is absent and
    ``KeeperSchemaError`` if its schema is unsupported — callers should treat
    both as hard failures (build-forward: no silent fallback).
    """
    path = _resolve_db_path()
    conn = _open_readonly(path)
    try:
        _check_schema(conn)

        on_hook: list[tuple[str, str]] = list(
            conn.execute(
                "SELECT project_dir, file_path FROM file_attributions "
                "WHERE session_id = ? "
                "AND (last_commit_at IS NULL OR last_commit_at < last_mutation_at)",
                (session_id,),
            )
        )

        dirty_by_repo = _dirty_paths_by_repo(conn)

        files_by_repo: dict[str, list[str]] = {}
        for project_dir, file_path in on_hook:
            # Only surface files that are still dirty in the working tree —
            # an undischarged-but-reverted edit must not be staged.
            if file_path in dirty_by_repo.get(project_dir, set()):
                files_by_repo.setdefault(project_dir, []).append(file_path)

        # Stable order for deterministic output (callers may diff the list).
        for paths in files_by_repo.values():
            paths.sort()

        # cwd_repo is resolved against the full known-repo universe (every
        # git_status row), not just repos with on-hook files, so it is
        # correct even when the cwd's repo has nothing to commit.
        cwd_repo = _resolve_cwd_repo(cwd, list(dirty_by_repo.keys()))

        return {"files_by_repo": files_by_repo, "cwd_repo": cwd_repo}
    finally:
        conn.close()


def get_session_titles() -> dict[str, str]:
    """Return ``{session_id: title}`` for every job that has a title.

    Reads keeper's ``jobs`` projection (``job_id`` is the session id in v1;
    ``title`` is the human-readable session name, seeded at SessionStart and
    refined by prompt/transcript per the reducer's ``title_source``
    precedence).  Jobs with a NULL ``title`` are omitted, mirroring the old
    hooks-tracker ``WHERE name IS NOT NULL`` filter.

    Raises ``KeeperDBMissing`` / ``KeeperSchemaError`` like the other readers
    here — no silent fallback.
    """
    path = _resolve_db_path()
    conn = _open_readonly(path)
    try:
        _check_schema(conn)
        return {
            job_id: title
            for job_id, title in conn.execute(
                "SELECT job_id, title FROM jobs WHERE title IS NOT NULL"
            )
        }
    finally:
        conn.close()
