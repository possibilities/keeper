"""Stdlib-only tests for keeper.api's read-only projection readers.

Runs with ``python -m unittest`` from ``keeper-py/`` — no pytest, no deps,
matching the package's stdlib-only contract.  Each test class builds a temp
DB with the relevant v31-shaped projection tables and exercises one reader.
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
    get_epic,
    get_job,
    get_latest_session,
    get_session_for_pid,
    get_session_identity_for_pid,
    get_session_name_history,
    get_session_titles,
)


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


def _add_job_identity(path, job_id, *, pid, title, name_history, updated_at=0.0):
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO jobs (job_id, title, name_history, pid, updated_at) "
        "VALUES (?,?,?,?,?)",
        (job_id, title, name_history, pid, updated_at),
    )
    conn.commit()
    conn.close()


class GetSessionIdentityForPidTest(unittest.TestCase):
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

    def test_returns_live_title_and_history(self):
        _add_job_identity(
            self.db,
            "sess-1",
            pid=4242,
            title="renamed-live",
            name_history=json.dumps(["launch-name", "renamed-live"]),
            updated_at=100.0,
        )
        self.assertEqual(
            get_session_identity_for_pid(4242),
            {
                "session_id": "sess-1",
                "title": "renamed-live",
                "name_history": ["launch-name", "renamed-live"],
            },
        )

    def test_latest_wins_for_reused_pid(self):
        _add_job_identity(
            self.db,
            "sess-old",
            pid=7,
            title="old",
            name_history=json.dumps(["old"]),
            updated_at=100.0,
        )
        _add_job_identity(
            self.db,
            "sess-new",
            pid=7,
            title="new",
            name_history=json.dumps(["new"]),
            updated_at=200.0,
        )
        ident = get_session_identity_for_pid(7)
        assert ident is not None
        self.assertEqual(ident["session_id"], "sess-new")
        self.assertEqual(ident["title"], "new")

    def test_null_title_folds_to_none(self):
        _add_job_identity(
            self.db,
            "sess-1",
            pid=9,
            title=None,
            name_history=json.dumps(["a"]),
            updated_at=100.0,
        )
        ident = get_session_identity_for_pid(9)
        assert ident is not None
        self.assertIsNone(ident["title"])
        self.assertEqual(ident["name_history"], ["a"])

    def test_malformed_history_folds_to_empty_list(self):
        _add_job_identity(
            self.db,
            "sess-1",
            pid=11,
            title="t",
            name_history="not-json",
            updated_at=100.0,
        )
        ident = get_session_identity_for_pid(11)
        assert ident is not None
        self.assertEqual(ident["name_history"], [])

    def test_returns_none_when_pid_absent(self):
        _add_job_identity(
            self.db,
            "sess-1",
            pid=1,
            title="t",
            name_history=json.dumps([]),
            updated_at=100.0,
        )
        self.assertIsNone(get_session_identity_for_pid(9999))

    def test_returns_none_on_empty_db(self):
        self.assertIsNone(get_session_identity_for_pid(1234))

    def test_unsupported_schema_raises(self):
        bad = Path(self._tmp.name) / "bad.db"
        _build_jobs_db(bad, schema_version=30)
        os.environ["KEEPER_DB"] = str(bad)
        with self.assertRaises(KeeperSchemaError):
            get_session_identity_for_pid(1234)

    def test_missing_db_raises(self):
        os.environ["KEEPER_DB"] = str(Path(self._tmp.name) / "nope.db")
        with self.assertRaises(KeeperDBMissing):
            get_session_identity_for_pid(1234)


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


def _build_epic_job_db(path: Path, *, schema_version: int = 31) -> None:
    """Build a temp DB with ``meta`` + ``epics`` + ``jobs`` for the
    ``get_epic`` / ``get_job`` readers.

    ``jobs`` carries the four columns ``get_job`` projects
    (``job_id`` / ``transcript_path`` / ``cwd`` / ``state``) plus a few
    others so the row shape stays close to real keeper writes.  ``epics``
    carries the four columns ``get_epic`` projects (``epic_id`` /
    ``project_dir`` / ``tasks`` / ``jobs``) — both array-typed columns
    default to ``'[]'`` mirroring ``CREATE_EPICS``.
    """
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
        (str(schema_version),),
    )
    conn.execute(
        "CREATE TABLE jobs ("
        "job_id TEXT PRIMARY KEY, "
        "transcript_path TEXT, "
        "cwd TEXT, "
        "state TEXT NOT NULL DEFAULT 'stopped', "
        "plan_verb TEXT, "
        "plan_ref TEXT"
        ")"
    )
    conn.execute(
        "CREATE TABLE epics ("
        "epic_id TEXT PRIMARY KEY, "
        "project_dir TEXT, "
        "tasks TEXT NOT NULL DEFAULT '[]', "
        "jobs TEXT NOT NULL DEFAULT '[]'"
        ")"
    )
    conn.commit()
    conn.close()


def _add_job_row(
    path,
    job_id,
    *,
    transcript_path=None,
    cwd=None,
    state="stopped",
):
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO jobs (job_id, transcript_path, cwd, state) VALUES (?,?,?,?)",
        (job_id, transcript_path, cwd, state),
    )
    conn.commit()
    conn.close()


def _add_epic_row(
    path,
    epic_id,
    *,
    project_dir=None,
    tasks_cell="[]",
    jobs_cell="[]",
):
    """Insert an epic row with literal JSON-TEXT cells for ``tasks`` / ``jobs``.

    Pass a ``json.dumps([...])`` for well-formed arrays, or a raw string
    like ``"not-json"`` / ``json.dumps({"not": "a list"})`` to exercise
    the defensive parse path.
    """
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO epics (epic_id, project_dir, tasks, jobs) VALUES (?,?,?,?)",
        (epic_id, project_dir, tasks_cell, jobs_cell),
    )
    conn.commit()
    conn.close()


class GetEpicTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.db = Path(self._tmp.name) / "keeper.db"
        _build_epic_job_db(self.db)
        self._prev = os.environ.get("KEEPER_DB")
        os.environ["KEEPER_DB"] = str(self.db)

    def tearDown(self) -> None:
        if self._prev is None:
            os.environ.pop("KEEPER_DB", None)
        else:
            os.environ["KEEPER_DB"] = self._prev
        self._tmp.cleanup()

    def test_happy_returns_epic_with_decoded_arrays(self):
        tasks = [
            {
                "task_id": "fn-1-foo.1",
                "jobs": [
                    {"job_id": "j-a", "plan_verb": "work", "created_at": 100.0},
                ],
            },
        ]
        jobs = [{"job_id": "j-plan", "plan_verb": "plan", "created_at": 50.0}]
        _add_epic_row(
            self.db,
            "fn-1-foo",
            project_dir="/repo",
            tasks_cell=json.dumps(tasks),
            jobs_cell=json.dumps(jobs),
        )
        result = get_epic("fn-1-foo")
        self.assertEqual(
            result,
            {
                "epic_id": "fn-1-foo",
                "project_dir": "/repo",
                "tasks": tasks,
                "jobs": jobs,
            },
        )
        assert result is not None  # narrow for ty
        # Embedded `created_at` survives — downstream freshest-pick relies on it.
        self.assertEqual(result["jobs"][0]["created_at"], 50.0)
        self.assertEqual(result["tasks"][0]["jobs"][0]["created_at"], 100.0)

    def test_missing_row_returns_none(self):
        self.assertIsNone(get_epic("fn-nope"))

    def test_malformed_tasks_cell_folds_to_empty_list(self):
        _add_epic_row(
            self.db,
            "fn-1-bad",
            project_dir="/repo",
            tasks_cell="not-json",
            jobs_cell=json.dumps([{"job_id": "j-1"}]),
        )
        result = get_epic("fn-1-bad")
        assert result is not None  # narrow for ty
        self.assertEqual(result["tasks"], [])
        # The OTHER array decodes normally — one bad cell doesn't poison the row.
        self.assertEqual(result["jobs"], [{"job_id": "j-1"}])

    def test_malformed_jobs_cell_folds_to_empty_list(self):
        # A JSON object (not an array) must also fold to [] — matches the
        # `Array.isArray(x) ? x : []` defense the TS renderer uses.
        _add_epic_row(
            self.db,
            "fn-1-obj",
            project_dir="/repo",
            tasks_cell=json.dumps([]),
            jobs_cell=json.dumps({"not": "a list"}),
        )
        result = get_epic("fn-1-obj")
        assert result is not None  # narrow for ty
        self.assertEqual(result["jobs"], [])

    def test_default_empty_array_cells_decode_to_empty_lists(self):
        # The schema default '[]' applies when no tasks/jobs are supplied.
        conn = sqlite3.connect(self.db)
        conn.execute(
            "INSERT INTO epics (epic_id, project_dir) VALUES (?, ?)",
            ("fn-1-empty", "/repo"),
        )
        conn.commit()
        conn.close()
        result = get_epic("fn-1-empty")
        assert result is not None  # narrow for ty
        self.assertEqual(result["tasks"], [])
        self.assertEqual(result["jobs"], [])

    def test_unsupported_schema_raises(self):
        bad = Path(self._tmp.name) / "bad.db"
        _build_epic_job_db(bad, schema_version=30)
        os.environ["KEEPER_DB"] = str(bad)
        with self.assertRaises(KeeperSchemaError):
            get_epic("fn-1-foo")

    def test_missing_db_raises(self):
        os.environ["KEEPER_DB"] = str(Path(self._tmp.name) / "nope.db")
        with self.assertRaises(KeeperDBMissing):
            get_epic("fn-1-foo")


class GetJobTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.db = Path(self._tmp.name) / "keeper.db"
        _build_epic_job_db(self.db)
        self._prev = os.environ.get("KEEPER_DB")
        os.environ["KEEPER_DB"] = str(self.db)

    def tearDown(self) -> None:
        if self._prev is None:
            os.environ.pop("KEEPER_DB", None)
        else:
            os.environ["KEEPER_DB"] = self._prev
        self._tmp.cleanup()

    def test_happy_returns_real_columns(self):
        _add_job_row(
            self.db,
            "sess-1",
            transcript_path="/abs/path/to/transcript.jsonl",
            cwd="/repo",
            state="running",
        )
        self.assertEqual(
            get_job("sess-1"),
            {
                "job_id": "sess-1",
                "transcript_path": "/abs/path/to/transcript.jsonl",
                "cwd": "/repo",
                "state": "running",
            },
        )

    def test_missing_row_returns_none(self):
        self.assertIsNone(get_job("sess-nope"))

    def test_null_transcript_and_cwd_propagate(self):
        # Both columns are nullable on the real schema — surface as None.
        _add_job_row(self.db, "sess-empty")
        self.assertEqual(
            get_job("sess-empty"),
            {
                "job_id": "sess-empty",
                "transcript_path": None,
                "cwd": None,
                "state": "stopped",
            },
        )

    def test_unsupported_schema_raises(self):
        bad = Path(self._tmp.name) / "bad.db"
        _build_epic_job_db(bad, schema_version=30)
        os.environ["KEEPER_DB"] = str(bad)
        with self.assertRaises(KeeperSchemaError):
            get_job("sess-1")

    def test_missing_db_raises(self):
        os.environ["KEEPER_DB"] = str(Path(self._tmp.name) / "nope.db")
        with self.assertRaises(KeeperDBMissing):
            get_job("sess-1")


if __name__ == "__main__":
    unittest.main()
