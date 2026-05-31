"""Stdlib-only tests for keeper.api.get_session_dirty_files.

Runs with ``python -m unittest`` from ``keeper-py/`` — no pytest, no deps,
matching the package's stdlib-only contract.  Builds a temp DB with the
v31-shaped ``meta`` / ``file_attributions`` / ``git_status`` tables and
exercises the attribution + dirty-intersection rules.
"""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

from keeper.api import (
    KeeperDBMissing,
    KeeperSchemaError,
    get_latest_session,
    get_session_dirty_files,
    get_session_for_pid,
    get_session_name_history,
    get_session_titles,
)


def _build_db(path: Path, *, schema_version: int = 31) -> None:
    conn = sqlite3.connect(path)
    # Real keeper shape: meta is a key/value table, version stored as TEXT.
    conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
        (str(schema_version),),
    )
    conn.execute(
        """CREATE TABLE file_attributions (
            project_dir TEXT NOT NULL,
            session_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            last_mutation_at REAL NOT NULL,
            last_commit_at REAL,
            op TEXT NOT NULL,
            source TEXT NOT NULL,
            last_event_id INTEGER,
            updated_at REAL NOT NULL DEFAULT 0,
            PRIMARY KEY (project_dir, session_id, file_path)
        )"""
    )
    conn.execute(
        """CREATE TABLE git_status (
            project_dir TEXT PRIMARY KEY,
            dirty_files TEXT NOT NULL DEFAULT '[]'
        )"""
    )
    conn.commit()
    conn.close()


def _add_attrib(path, project_dir, session_id, file_path, mut, commit, src="tool"):
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO file_attributions "
        "(project_dir, session_id, file_path, last_mutation_at, last_commit_at, op, source) "
        "VALUES (?,?,?,?,?,?,?)",
        (project_dir, session_id, file_path, mut, commit, src, src),
    )
    conn.commit()
    conn.close()


def _set_dirty(path, project_dir, rel_paths):
    cell = json.dumps([{"path": p, "xy": " M", "mtime_ms": None} for p in rel_paths])
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO git_status (project_dir, dirty_files) VALUES (?, ?) "
        "ON CONFLICT(project_dir) DO UPDATE SET dirty_files = excluded.dirty_files",
        (project_dir, cell),
    )
    conn.commit()
    conn.close()


class GetSessionDirtyFilesTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.db = Path(self._tmp.name) / "keeper.db"
        _build_db(self.db)
        self._prev = os.environ.get("KEEPER_DB")
        os.environ["KEEPER_DB"] = str(self.db)

    def tearDown(self) -> None:
        if self._prev is None:
            os.environ.pop("KEEPER_DB", None)
        else:
            os.environ["KEEPER_DB"] = self._prev
        self._tmp.cleanup()

    def test_on_hook_and_dirty_is_returned(self):
        _add_attrib(self.db, "/repo", "sess", "src/a.ts", mut=100, commit=None)
        _set_dirty(self.db, "/repo", ["src/a.ts"])
        result = get_session_dirty_files("sess", "/repo")
        self.assertEqual(result["files_by_repo"], {"/repo": ["src/a.ts"]})
        self.assertEqual(result["cwd_repo"], "/repo")

    def test_discharged_file_excluded(self):
        # last_commit_at > last_mutation_at → committed since the edit → off hook.
        _add_attrib(self.db, "/repo", "sess", "src/a.ts", mut=100, commit=200)
        _set_dirty(self.db, "/repo", ["src/a.ts"])
        result = get_session_dirty_files("sess", "/repo")
        self.assertEqual(result["files_by_repo"], {})

    def test_re_mutated_after_commit_back_on_hook(self):
        _add_attrib(self.db, "/repo", "sess", "src/a.ts", mut=300, commit=200)
        _set_dirty(self.db, "/repo", ["src/a.ts"])
        result = get_session_dirty_files("sess", "/repo")
        self.assertEqual(result["files_by_repo"], {"/repo": ["src/a.ts"]})

    def test_on_hook_but_not_dirty_excluded(self):
        # Undischarged but reverted → not in git_status.dirty_files → skip.
        _add_attrib(self.db, "/repo", "sess", "src/a.ts", mut=100, commit=None)
        _set_dirty(self.db, "/repo", [])
        result = get_session_dirty_files("sess", "/repo")
        self.assertEqual(result["files_by_repo"], {})

    def test_other_session_not_returned(self):
        _add_attrib(self.db, "/repo", "other", "src/a.ts", mut=100, commit=None)
        _set_dirty(self.db, "/repo", ["src/a.ts"])
        result = get_session_dirty_files("sess", "/repo")
        self.assertEqual(result["files_by_repo"], {})

    def test_cwd_repo_longest_prefix_wins(self):
        _set_dirty(self.db, "/repo", [])
        _set_dirty(self.db, "/repo/inner", [])
        result = get_session_dirty_files("sess", "/repo/inner/sub")
        self.assertEqual(result["cwd_repo"], "/repo/inner")

    def test_cwd_outside_any_repo_is_none(self):
        _set_dirty(self.db, "/repo", [])
        result = get_session_dirty_files("sess", "/elsewhere")
        self.assertIsNone(result["cwd_repo"])

    def test_unsupported_schema_raises(self):
        bad = Path(self._tmp.name) / "bad.db"
        _build_db(bad, schema_version=30)
        os.environ["KEEPER_DB"] = str(bad)
        with self.assertRaises(KeeperSchemaError):
            get_session_dirty_files("sess", "/repo")

    def test_missing_db_raises(self):
        os.environ["KEEPER_DB"] = str(Path(self._tmp.name) / "nope.db")
        with self.assertRaises(KeeperDBMissing):
            get_session_dirty_files("sess", "/repo")


def _build_jobs_db(path: Path, *, schema_version: int = 31) -> None:
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
        (str(schema_version),),
    )
    # Minimal jobs shape — covers columns every keeper.api reader hits
    # (title / name_history for the title readers, pid / cwd / updated_at for
    # the fn-615.1 readers).
    conn.execute(
        "CREATE TABLE jobs ("
        "job_id TEXT PRIMARY KEY, "
        "title TEXT, "
        "title_source TEXT, "
        "name_history TEXT NOT NULL DEFAULT '[]', "
        "pid INTEGER, "
        "cwd TEXT, "
        "updated_at REAL NOT NULL DEFAULT 0"
        ")"
    )
    conn.commit()
    conn.close()


def _add_job(path, job_id, title):
    conn = sqlite3.connect(path)
    conn.execute("INSERT INTO jobs (job_id, title) VALUES (?, ?)", (job_id, title))
    conn.commit()
    conn.close()


def _add_job_with_history(path, job_id, history_cell):
    """Insert a job row with a literal ``name_history`` cell (str or None).

    ``history_cell`` is written verbatim — pass a ``json.dumps([...])`` for
    well-formed arrays or a raw string like ``"not-json"`` to exercise the
    defensive parse path.
    """
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO jobs (job_id, title, name_history) VALUES (?, ?, ?)",
        (job_id, None, history_cell),
    )
    conn.commit()
    conn.close()


class GetSessionTitlesTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.db = Path(self._tmp.name) / "keeper.db"
        _build_jobs_db(self.db)
        self._prev = os.environ.get("KEEPER_DB")
        os.environ["KEEPER_DB"] = str(self.db)

    def tearDown(self) -> None:
        if self._prev is None:
            os.environ.pop("KEEPER_DB", None)
        else:
            os.environ["KEEPER_DB"] = self._prev
        self._tmp.cleanup()

    def test_titled_jobs_returned(self):
        _add_job(self.db, "sess-1", "first-session")
        _add_job(self.db, "sess-2", "second-session")
        self.assertEqual(
            get_session_titles(),
            {"sess-1": "first-session", "sess-2": "second-session"},
        )

    def test_null_title_omitted(self):
        _add_job(self.db, "sess-1", "named")
        _add_job(self.db, "sess-2", None)
        self.assertEqual(get_session_titles(), {"sess-1": "named"})

    def test_empty_when_no_jobs(self):
        self.assertEqual(get_session_titles(), {})

    def test_unsupported_schema_raises(self):
        bad = Path(self._tmp.name) / "bad.db"
        _build_jobs_db(bad, schema_version=30)
        os.environ["KEEPER_DB"] = str(bad)
        with self.assertRaises(KeeperSchemaError):
            get_session_titles()

    def test_missing_db_raises(self):
        os.environ["KEEPER_DB"] = str(Path(self._tmp.name) / "nope.db")
        with self.assertRaises(KeeperDBMissing):
            get_session_titles()


class GetSessionNameHistoryTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.db = Path(self._tmp.name) / "keeper.db"
        _build_jobs_db(self.db)
        self._prev = os.environ.get("KEEPER_DB")
        os.environ["KEEPER_DB"] = str(self.db)

    def tearDown(self) -> None:
        if self._prev is None:
            os.environ.pop("KEEPER_DB", None)
        else:
            os.environ["KEEPER_DB"] = self._prev
        self._tmp.cleanup()

    def test_multi_name_history_in_order(self):
        _add_job_with_history(
            self.db, "sess-1", json.dumps(["first", "second", "third"])
        )
        _add_job_with_history(self.db, "sess-2", json.dumps(["only"]))
        self.assertEqual(
            get_session_name_history(),
            {"sess-1": ["first", "second", "third"], "sess-2": ["only"]},
        )

    def test_empty_history_returns_empty_list(self):
        # The schema default '[]' applies when no name_history is supplied.
        _add_job(self.db, "sess-1", "named")
        self.assertEqual(get_session_name_history(), {"sess-1": []})

    def test_malformed_cell_folds_to_empty(self):
        _add_job_with_history(self.db, "sess-1", "not-json")
        _add_job_with_history(self.db, "sess-2", json.dumps({"not": "a list"}))
        # Non-string entries inside an array are filtered out, not the whole row.
        _add_job_with_history(self.db, "sess-3", json.dumps(["ok", 42, None, "fine"]))
        self.assertEqual(
            get_session_name_history(),
            {"sess-1": [], "sess-2": [], "sess-3": ["ok", "fine"]},
        )

    def test_empty_when_no_jobs(self):
        self.assertEqual(get_session_name_history(), {})

    def test_unsupported_schema_raises(self):
        bad = Path(self._tmp.name) / "bad.db"
        _build_jobs_db(bad, schema_version=30)
        os.environ["KEEPER_DB"] = str(bad)
        with self.assertRaises(KeeperSchemaError):
            get_session_name_history()

    def test_missing_db_raises(self):
        os.environ["KEEPER_DB"] = str(Path(self._tmp.name) / "nope.db")
        with self.assertRaises(KeeperDBMissing):
            get_session_name_history()


def _add_job_full(path, job_id, *, pid=None, cwd=None, title=None, updated_at=0.0):
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO jobs (job_id, title, pid, cwd, updated_at) VALUES (?,?,?,?,?)",
        (job_id, title, pid, cwd, updated_at),
    )
    conn.commit()
    conn.close()


class GetSessionForPidTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.db = Path(self._tmp.name) / "keeper.db"
        _build_jobs_db(self.db)
        self._prev = os.environ.get("KEEPER_DB")
        os.environ["KEEPER_DB"] = str(self.db)

    def tearDown(self) -> None:
        if self._prev is None:
            os.environ.pop("KEEPER_DB", None)
        else:
            os.environ["KEEPER_DB"] = self._prev
        self._tmp.cleanup()

    def test_latest_wins_for_reused_pid(self):
        # Two rows sharing pid=4242 — newer updated_at wins.
        _add_job_full(self.db, "sess-old", pid=4242, updated_at=100.0)
        _add_job_full(self.db, "sess-new", pid=4242, updated_at=200.0)
        self.assertEqual(get_session_for_pid(4242), "sess-new")

    def test_returns_none_when_pid_absent(self):
        _add_job_full(self.db, "sess-1", pid=1111, updated_at=100.0)
        self.assertIsNone(get_session_for_pid(9999))

    def test_returns_none_on_empty_db(self):
        self.assertIsNone(get_session_for_pid(1234))

    def test_unsupported_schema_raises(self):
        bad = Path(self._tmp.name) / "bad.db"
        _build_jobs_db(bad, schema_version=30)
        os.environ["KEEPER_DB"] = str(bad)
        with self.assertRaises(KeeperSchemaError):
            get_session_for_pid(1234)

    def test_missing_db_raises(self):
        os.environ["KEEPER_DB"] = str(Path(self._tmp.name) / "nope.db")
        with self.assertRaises(KeeperDBMissing):
            get_session_for_pid(1234)


class GetLatestSessionTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.db = Path(self._tmp.name) / "keeper.db"
        _build_jobs_db(self.db)
        self._prev = os.environ.get("KEEPER_DB")
        os.environ["KEEPER_DB"] = str(self.db)

    def tearDown(self) -> None:
        if self._prev is None:
            os.environ.pop("KEEPER_DB", None)
        else:
            os.environ["KEEPER_DB"] = self._prev
        self._tmp.cleanup()

    def test_returns_freshest_job_with_title(self):
        _add_job_full(self.db, "sess-old", cwd="/old", title="old", updated_at=100.0)
        _add_job_full(self.db, "sess-new", cwd="/new", title="new", updated_at=200.0)
        self.assertEqual(
            get_latest_session(),
            {"session-id": "sess-new", "cwd": "/new", "session-name": "new"},
        )

    def test_omits_session_name_when_title_null(self):
        _add_job_full(self.db, "sess-1", cwd="/repo", title=None, updated_at=100.0)
        self.assertEqual(
            get_latest_session(),
            {"session-id": "sess-1", "cwd": "/repo"},
        )

    def test_returns_none_on_empty_db(self):
        self.assertIsNone(get_latest_session())

    def test_unsupported_schema_raises(self):
        bad = Path(self._tmp.name) / "bad.db"
        _build_jobs_db(bad, schema_version=30)
        os.environ["KEEPER_DB"] = str(bad)
        with self.assertRaises(KeeperSchemaError):
            get_latest_session()

    def test_missing_db_raises(self):
        os.environ["KEEPER_DB"] = str(Path(self._tmp.name) / "nope.db")
        with self.assertRaises(KeeperDBMissing):
            get_latest_session()


if __name__ == "__main__":
    unittest.main()
