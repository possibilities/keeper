"""Engine-agnostic conformance spec for the four read-only verbs.

``state-path`` / ``detect`` / ``status`` / ``epics`` — the executable spec the
``planctl-bun`` port targets. Every fixture is seeded with the CLI-free
``seed_state`` disk builder + ``monkeypatch.chdir`` (the tests/test_session_markers.py
seeding shape), so under conformance only the verb-under-test crosses the
``PLANCTL_BIN`` subprocess boundary.

What is pinned, per the wire spec:

* The primary JSON envelope byte-for-byte (``json_dumps``: 2-space indent,
  ``success`` first, one trailing newline, ``ensure_ascii=False``).
* The trailing ``planctl_invocation`` NDJSON line byte-for-byte (compact
  separators, field order files/op/target/subject/touched_path_files/repo_root/
  state_repo, ``target`` null for these verbs, repo_root == state_repo ==
  resolved project path).
* ``--format yaml`` and ``--format human`` surfaces for status + epics.
* Missing-project error envelope + exit 1 for state-path/status/epics.
* The schema_version asymmetry (detect default 0, status default 1).
* A non-ASCII title fixture (ensure_ascii=False <-> JS-default unicode parity).

Path-bearing fields are computed from ``tmp_path.resolve()`` (both engines
resolve the project root through ``Path.resolve()``); everything else is a
literal pin.
"""

from __future__ import annotations

import json

from .conftest import run_cli, seed_state


def _split(output: str) -> tuple[str, str | None]:
    """Split CLI stdout into (primary_text, trailer_line).

    The read-only decorator appends a trailing ``{"planctl_invocation": ...}``
    compact NDJSON line. Returns the primary block (newline-joined, with a
    trailing newline preserved) and the trailer line verbatim (or ``None`` when
    absent). Only the LAST ``planctl_invocation`` line is treated as the trailer
    so a primary payload that happens to mention the key is never mis-split.
    """
    lines = output.splitlines(keepends=True)
    trailer = None
    if lines and lines[-1].lstrip().startswith('{"planctl_invocation"'):
        trailer = lines[-1].rstrip("\n")
        lines = lines[:-1]
    return "".join(lines), trailer


def _expected_trailer(op: str, root: str) -> str:
    """The byte-exact compact trailer line for a read-only verb with no target.

    The whole envelope (``{"planctl_invocation": {...}}``) is serialized with
    compact separators; ``target`` is null for verbs with no positional id, and
    repo_root == state_repo == the resolved project root.
    """
    return json.dumps(
        {
            "planctl_invocation": {
                "files": None,
                "op": op,
                "target": None,
                "subject": None,
                "touched_path_files": [],
                "repo_root": root,
                "state_repo": root,
            }
        },
        separators=(",", ":"),
    )


def _seed_empty_project(tmp_path):
    """Build a bare ``.planctl/`` skeleton (no epics/tasks) — the empty-project
    zero-count fixture. Mirrors ``seed_state``'s skeleton without minting an epic.
    """
    from planctl.models import SCHEMA_VERSION
    from planctl.store import atomic_write_json

    planctl_dir = tmp_path / ".planctl"
    for subdir in ("epics", "specs", "tasks", "state"):
        (planctl_dir / subdir).mkdir(parents=True, exist_ok=True)
    atomic_write_json(planctl_dir / "meta.json", {"schema_version": SCHEMA_VERSION})


def _seed_mixed(tmp_path):
    """Seed the canonical mixed fixture used across the byte-exact pins.

    * ``fn-1-cafe`` — non-ASCII title, 3 tasks: one todo (default overlay
      absent), one in_progress, one done (status-count + never-claimed-default
      coverage in one tree).
    * ``fn-zzz-weird`` — unparseable id (sorts LAST via parse_id 999), 0 tasks.
    """
    from planctl.store import LocalFileStateStore

    epic_id, task_ids = seed_state(
        tmp_path, epic_id="fn-1-cafe", title="Café résumé ☕", n_tasks=3
    )
    store = LocalFileStateStore(tmp_path / ".planctl" / "state")
    store.save_runtime(
        task_ids[1], {"status": "in_progress", "assignee": "test@example.com"}
    )
    store.save_runtime(task_ids[2], {"status": "done", "assignee": "test@example.com"})
    seed_state(tmp_path, epic_id="fn-zzz-weird", title="Weird", n_tasks=0)
    return epic_id, task_ids


# ---------------------------------------------------------------------------
# state-path
# ---------------------------------------------------------------------------


def test_state_path_envelope(tmp_path, monkeypatch):
    seed_state(tmp_path, epic_id="fn-1-cafe", n_tasks=1)
    monkeypatch.chdir(tmp_path)
    root = str(tmp_path.resolve())

    result = run_cli(["state-path"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    primary, trailer = _split(result.output)
    assert primary == (
        f'{{\n  "success": true,\n  "state_dir": "{root}/.planctl/state"\n}}\n'
    )
    assert trailer == _expected_trailer("state-path", root)


def test_state_path_missing_project_errors(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    result = run_cli(["state-path"], cwd=tmp_path)
    assert result.exit_code == 1
    primary, _ = _split(result.output)
    assert primary == (
        "{\n"
        '  "success": false,\n'
        '  "error": "No planctl project found. Run \'planctl init\' first."\n'
        "}\n"
    )


# ---------------------------------------------------------------------------
# detect
# ---------------------------------------------------------------------------


def test_detect_found_true(tmp_path, monkeypatch):
    """found-true: meta.json present -> name/path/schema_version (status's
    schema_version default is 1, detect's is 0 — here meta carries the real
    SCHEMA_VERSION so both read it back identically)."""
    seed_state(tmp_path, epic_id="fn-1-cafe", n_tasks=1)
    monkeypatch.chdir(tmp_path)
    root = str(tmp_path.resolve())
    name = tmp_path.resolve().name

    result = run_cli(["detect"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    primary, trailer = _split(result.output)
    from planctl.models import SCHEMA_VERSION

    assert primary == (
        "{\n"
        '  "success": true,\n'
        '  "found": true,\n'
        '  "project": {\n'
        f'    "name": "{name}",\n'
        f'    "path": "{root}",\n'
        f'    "schema_version": {SCHEMA_VERSION}\n'
        "  }\n"
        "}\n"
    )
    assert trailer == _expected_trailer("detect", root)


def test_detect_schema_version_default_zero(tmp_path, monkeypatch):
    """detect's schema_version default is 0 (asymmetry with status's 1):
    when meta.json is absent/corrupt the field falls back to 0, not 1."""
    planctl_dir = tmp_path / ".planctl"
    planctl_dir.mkdir()
    # No meta.json -> load_json_safe returns falsy -> schema_version default 0.
    monkeypatch.chdir(tmp_path)
    root = str(tmp_path.resolve())
    name = tmp_path.resolve().name

    result = run_cli(["detect"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    primary, trailer = _split(result.output)
    assert primary == (
        "{\n"
        '  "success": true,\n'
        '  "found": true,\n'
        '  "project": {\n'
        f'    "name": "{name}",\n'
        f'    "path": "{root}",\n'
        '    "schema_version": 0\n'
        "  }\n"
        "}\n"
    )
    assert trailer == _expected_trailer("detect", root)


def test_detect_found_false(tmp_path, monkeypatch):
    """found-false: no ``.planctl/`` dir -> the verb emits a bare
    ``{found: false}`` envelope.

    The verb itself exits 0, but the read-only invocation trailer resolves the
    project to build its repo_root and hits the same missing-project guard,
    appending the error envelope and exiting 1. Both Python engines reproduce
    this trailer-induced tail identically, so it is pinned as the contract: the
    primary ``found: false`` line is the verb's authoritative output, followed
    by the resolver error and exit 1.
    """
    monkeypatch.chdir(tmp_path)
    result = run_cli(["detect"], cwd=tmp_path)
    assert result.exit_code == 1
    # First line block: the verb's own found-false envelope.
    assert result.output.startswith('{\n  "success": true,\n  "found": false\n}\n')
    # No planctl_invocation trailer (the resolver raised before emitting it).
    assert '"planctl_invocation"' not in result.output
    # The resolver's missing-project error envelope tails the output.
    assert (
        "{\n"
        '  "success": false,\n'
        '  "error": "No planctl project found. Run \'planctl init\' first."\n'
        "}\n"
    ) in result.output


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------


def test_status_counts_json(tmp_path, monkeypatch):
    """Counts across the mixed fixture incl. the never-claimed default (absent
    runtime overlay -> todo) and schema_version default 1."""
    _seed_mixed(tmp_path)
    monkeypatch.chdir(tmp_path)
    root = str(tmp_path.resolve())
    name = tmp_path.resolve().name

    result = run_cli(["status"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    primary, trailer = _split(result.output)
    assert primary == (
        "{\n"
        '  "success": true,\n'
        '  "project": {\n'
        f'    "name": "{name}",\n'
        f'    "path": "{root}",\n'
        '    "schema_version": 1\n'
        "  },\n"
        '  "epics": {\n'
        '    "total": 2,\n'
        '    "open": 2,\n'
        '    "done": 0\n'
        "  },\n"
        '  "tasks": {\n'
        '    "total": 3,\n'
        '    "todo": 1,\n'
        '    "in_progress": 1,\n'
        '    "done": 1,\n'
        '    "blocked": 0\n'
        "  }\n"
        "}\n"
    )
    assert trailer == _expected_trailer("status", root)


def test_status_empty_project_zero_counts(tmp_path, monkeypatch):
    _seed_empty_project(tmp_path)
    monkeypatch.chdir(tmp_path)
    root = str(tmp_path.resolve())
    name = tmp_path.resolve().name

    result = run_cli(["status"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    primary, trailer = _split(result.output)
    assert primary == (
        "{\n"
        '  "success": true,\n'
        '  "project": {\n'
        f'    "name": "{name}",\n'
        f'    "path": "{root}",\n'
        '    "schema_version": 1\n'
        "  },\n"
        '  "epics": {\n'
        '    "total": 0,\n'
        '    "open": 0,\n'
        '    "done": 0\n'
        "  },\n"
        '  "tasks": {\n'
        '    "total": 0,\n'
        '    "todo": 0,\n'
        '    "in_progress": 0,\n'
        '    "done": 0,\n'
        '    "blocked": 0\n'
        "  }\n"
        "}\n"
    )
    assert trailer == _expected_trailer("status", root)


def test_status_yaml(tmp_path, monkeypatch):
    _seed_mixed(tmp_path)
    monkeypatch.chdir(tmp_path)
    root = str(tmp_path.resolve())
    name = tmp_path.resolve().name

    result = run_cli(["--format", "yaml", "status"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    primary, trailer = _split(result.output)
    assert primary == (
        "success: true\n"
        "project:\n"
        f"  name: {name}\n"
        f"  path: {root}\n"
        "  schema_version: 1\n"
        "epics:\n"
        "  total: 2\n"
        "  open: 2\n"
        "  done: 0\n"
        "tasks:\n"
        "  total: 3\n"
        "  todo: 1\n"
        "  in_progress: 1\n"
        "  done: 1\n"
        "  blocked: 0\n"
    )
    assert trailer == _expected_trailer("status", root)


def test_status_human_falls_back_to_json(tmp_path, monkeypatch):
    """status has no text_renderer -> --format human falls back to JSON
    (identical bytes to the json surface)."""
    _seed_mixed(tmp_path)
    monkeypatch.chdir(tmp_path)

    human = run_cli(["--format", "human", "status"], cwd=tmp_path)
    js = run_cli(["status"], cwd=tmp_path)
    assert human.exit_code == 0 and js.exit_code == 0
    assert _split(human.output)[0] == _split(js.output)[0]


def test_status_missing_project_errors(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    result = run_cli(["status"], cwd=tmp_path)
    assert result.exit_code == 1
    primary, _ = _split(result.output)
    assert primary == (
        "{\n"
        '  "success": false,\n'
        '  "error": "No planctl project found. Run \'planctl init\' first."\n'
        "}\n"
    )


# ---------------------------------------------------------------------------
# epics
# ---------------------------------------------------------------------------


def test_epics_ordering_json(tmp_path, monkeypatch):
    """Ordering via parse_id: fn-1-cafe (epic 1) before fn-zzz-weird
    (unparseable -> sorts last as 999). Pins the non-ASCII title byte-for-byte
    (ensure_ascii=False)."""
    _seed_mixed(tmp_path)
    monkeypatch.chdir(tmp_path)
    root = str(tmp_path.resolve())

    result = run_cli(["epics"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    primary, trailer = _split(result.output)
    assert primary == (
        "{\n"
        '  "success": true,\n'
        '  "epics": [\n'
        "    {\n"
        '      "id": "fn-1-cafe",\n'
        '      "title": "Café résumé ☕",\n'
        '      "status": "open",\n'
        '      "branch_name": "main",\n'
        '      "task_summary": {\n'
        '        "total": 3,\n'
        '        "todo": 1,\n'
        '        "in_progress": 1,\n'
        '        "done": 1,\n'
        '        "blocked": 0\n'
        "      }\n"
        "    },\n"
        "    {\n"
        '      "id": "fn-zzz-weird",\n'
        '      "title": "Weird",\n'
        '      "status": "open",\n'
        '      "branch_name": "main",\n'
        '      "task_summary": {\n'
        '        "total": 0,\n'
        '        "todo": 0,\n'
        '        "in_progress": 0,\n'
        '        "done": 0,\n'
        '        "blocked": 0\n'
        "      }\n"
        "    }\n"
        "  ]\n"
        "}\n"
    )
    assert trailer == _expected_trailer("epics", root)


def test_epics_empty_project_json(tmp_path, monkeypatch):
    _seed_empty_project(tmp_path)
    monkeypatch.chdir(tmp_path)
    root = str(tmp_path.resolve())

    result = run_cli(["epics"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    primary, trailer = _split(result.output)
    assert primary == '{\n  "success": true,\n  "epics": []\n}\n'
    assert trailer == _expected_trailer("epics", root)


def test_epics_yaml(tmp_path, monkeypatch):
    _seed_mixed(tmp_path)
    monkeypatch.chdir(tmp_path)
    root = str(tmp_path.resolve())

    result = run_cli(["--format", "yaml", "epics"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    primary, trailer = _split(result.output)
    assert primary == (
        "success: true\n"
        "epics:\n"
        "- id: fn-1-cafe\n"
        "  title: Café résumé ☕\n"
        "  status: open\n"
        "  branch_name: main\n"
        "  task_summary:\n"
        "    total: 3\n"
        "    todo: 1\n"
        "    in_progress: 1\n"
        "    done: 1\n"
        "    blocked: 0\n"
        "- id: fn-zzz-weird\n"
        "  title: Weird\n"
        "  status: open\n"
        "  branch_name: main\n"
        "  task_summary:\n"
        "    total: 0\n"
        "    todo: 0\n"
        "    in_progress: 0\n"
        "    done: 0\n"
        "    blocked: 0\n"
    )
    assert trailer == _expected_trailer("epics", root)


def test_epics_human(tmp_path, monkeypatch):
    """epics owns a text_renderer (_render_human): the table view, with the
    non-zero-status parenthetical and the non-ASCII title preserved."""
    _seed_mixed(tmp_path)
    monkeypatch.chdir(tmp_path)
    root = str(tmp_path.resolve())

    result = run_cli(["--format", "human", "epics"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    primary, trailer = _split(result.output)
    assert primary == (
        "fn-1-cafe  Café résumé ☕  [open]  3 tasks (1 todo, 1 in_progress, 1 done)\n"
        "fn-zzz-weird  Weird  [open]  0 tasks\n"
    )
    assert trailer == _expected_trailer("epics", root)


def test_epics_missing_project_errors(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    result = run_cli(["epics"], cwd=tmp_path)
    assert result.exit_code == 1
    primary, _ = _split(result.output)
    assert primary == (
        "{\n"
        '  "success": false,\n'
        '  "error": "No planctl project found. Run \'planctl init\' first."\n'
        "}\n"
    )
