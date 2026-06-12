"""Engine-agnostic conformance spec for the read-surface query verbs.

``show`` / ``cat`` / ``list`` / ``ready`` / ``tasks`` / ``resolve-task`` /
``refine-context`` / ``validate`` — the executable spec the ``planctl-bun``
port targets. Every fixture is seeded with the CLI-free ``seed_state`` disk
builder + ``monkeypatch.chdir`` (the tests/test_readonly_verbs.py seeding
shape), so under conformance only the verb-under-test crosses the
``PLANCTL_BIN`` subprocess boundary. The existing scaffold-poisoned setter/
validate test files are left untouched — this module re-expresses the read
surface from a clean ``seed_state`` baseline.

What is pinned, per the wire spec:

* ``show`` task + epic envelopes (merged runtime status, task_summary counts).
* ``cat`` raw-markdown byte-out (``--format`` ignored, NO trailer, missing-spec
  error to stderr + exit 1).
* ``list`` human tree renderer — golden-pinned byte-for-byte against a captured
  corpus (``tests/fixtures/golden/list_human.txt``).
* ``ready`` ready / in_progress / blocked classification with met / unmet deps.
* ``tasks`` ``--epic`` / ``--status`` filters + sort order (unparseable id last).
* ``resolve-task`` typed errors, explicit-null tier, 3-level target_repo
  fallback, multi-project ambiguity (seed_state into two project dirs +
  set_roots).
* ``refine-context`` read envelope (epic_spec_md + tasks list, empty-string spec
  when absent, typed errors).
* ``validate`` whole-project ``{valid, errors, warnings}`` envelope (exit 1 on
  invalid, NO trailer, golden-pinned error catalog) and ``validate --epic``
  stamp state-machine (None -> timestamp + second compact invocation line, then
  already-stamped pure no-op, frozen-clock stamp equality).

Golden corpus
-------------
``tests/fixtures/golden/`` carries reference output captured from the real
Python binary under ``LC_ALL=C`` / ``NO_COLOR=1`` / a frozen ``PLANCTL_NOW``:

* ``list_human.txt`` — the ``list --format human`` tree render for the
  ``_seed_list_corpus`` fixture (path-free: only ids / titles / statuses /
  assignees, so no absolute tmp path leaks in).
* ``integrity_errors.txt`` — a representative path-free integrity error set
  (epic-dep-missing, task-dep-missing, task cycle) for the
  ``_seed_invalid_corpus`` fixture.

Regeneration recipe (run from the repo root)::

    PLANCTL_ACTOR=test@example.com PLANCTL_NOW=2026-06-06T00:00:00.000000Z \\
    LC_ALL=C NO_COLOR=1 uv run python - <<'PY'
    # Seed _seed_list_corpus / _seed_invalid_corpus into a tmp dir with
    # seed_state at the SAME ids/titles/statuses used below, chdir in, and run:
    #   planctl --format human list     -> list_human.txt  (drop the trailer line)
    #   planctl validate                -> integrity_errors.txt (the "errors" array)
    # Both fixtures are path-free by construction, so the captured bytes are
    # machine-independent. Path-bearing strings (repo warnings, cat errors) are
    # asserted dynamically below, never committed as goldens.
    PY

Path-bearing fields (resolve-task repo paths, the touched_repos repr warning,
the cat missing-spec error) are computed from ``tmp_path.resolve()`` /
``Path(...).resolve()`` inline — both engines resolve through ``Path.resolve()``
— and never live in a committed golden.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from .conftest import run_cli, seed_state, set_roots

_GOLDEN = Path(__file__).parent / "fixtures" / "golden"


def _golden(name: str) -> str:
    return (_GOLDEN / name).read_text(encoding="utf-8")


def _split(output: str) -> tuple[str, str | None]:
    """Split CLI stdout into (primary_text, trailer_line).

    The read-only decorator appends a trailing ``{"planctl_invocation": ...}``
    compact NDJSON line. Returns the primary block (trailing newline preserved)
    and the trailer line verbatim (or ``None`` when absent).
    """
    lines = output.splitlines(keepends=True)
    trailer = None
    if lines and lines[-1].lstrip().startswith('{"planctl_invocation"'):
        trailer = lines[-1].rstrip("\n")
        lines = lines[:-1]
    return "".join(lines), trailer


def _primary_envelope(output: str) -> dict:
    """The verb's primary JSON payload, NOT the bare invocation trailer.

    Tolerates both compact one-line and pretty-printed multi-line JSON. Two
    invocation shapes coexist: a standalone trailer line is the single-key
    object ``{"planctl_invocation": {...}}`` (skipped here), whereas
    ``resolve-task`` MERGES the invocation key into its payload object (kept —
    its other keys are the payload). So the rule is "skip a sole-key
    planctl_invocation object, return the first object with any other key".
    """
    decoder = json.JSONDecoder()
    text = output
    i = 0
    while i < len(text):
        if text[i] != "{":
            i += 1
            continue
        try:
            obj, end = decoder.raw_decode(text, i)
        except json.JSONDecodeError:
            i += 1
            continue
        if isinstance(obj, dict) and set(obj.keys()) != {"planctl_invocation"}:
            return obj
        i = end
    raise AssertionError(f"no primary JSON envelope in output:\n{output}")


def _trailer_obj(output: str) -> dict | None:
    """The trailing planctl_invocation object (parsed), or None when absent.

    For ``resolve-task`` the invocation rides the same physical line as the
    envelope, so scan every JSON object and return the one carrying the key.
    """
    decoder = json.JSONDecoder()
    text = output
    i = 0
    found = None
    while i < len(text):
        if text[i] != "{":
            i += 1
            continue
        try:
            obj, end = decoder.raw_decode(text, i)
        except json.JSONDecodeError:
            i += 1
            continue
        if isinstance(obj, dict) and "planctl_invocation" in obj:
            found = obj["planctl_invocation"]
        i = end
    return found


# ---------------------------------------------------------------------------
# Shared seeds
# ---------------------------------------------------------------------------


def _seed_show_corpus(tmp_path):
    """fn-1-cafe: 2 tasks, task .1 claimed in_progress; fn-2-zeta empty.

    Pins the merged-runtime status (.1 reads in_progress from the state overlay)
    and the epic task_summary counts.
    """
    from planctl.store import LocalFileStateStore

    seed_state(tmp_path, epic_id="fn-1-cafe", title="Cafe", n_tasks=2)
    store = LocalFileStateStore(tmp_path / ".planctl" / "state")
    store.save_runtime(
        "fn-1-cafe.1",
        {
            "status": "in_progress",
            "assignee": "test@example.com",
            "claimed_at": "2026-06-06T00:00:00.000000Z",
        },
    )
    seed_state(tmp_path, epic_id="fn-2-zeta", title="Zeta", n_tasks=0)


def _seed_list_corpus(tmp_path):
    """The golden-pinned ``list`` corpus — must match ``list_human.txt`` byte-exact.

    fn-1-cafe "Café résumé ☕": 3 tasks (todo / in_progress / done).
    fn-2-zeta "Zeta": 2 tasks (in_progress / todo).
    Both epics sort by number (cafe before zeta); tasks sort by ordinal.
    Path-free by construction so the captured golden is machine-independent.
    """
    from planctl.store import LocalFileStateStore

    seed_state(tmp_path, epic_id="fn-1-cafe", title="Café résumé ☕", n_tasks=3)
    seed_state(tmp_path, epic_id="fn-2-zeta", title="Zeta", n_tasks=2)
    store = LocalFileStateStore(tmp_path / ".planctl" / "state")
    store.save_runtime(
        "fn-1-cafe.2", {"status": "in_progress", "assignee": "test@example.com"}
    )
    store.save_runtime(
        "fn-1-cafe.3", {"status": "done", "assignee": "test@example.com"}
    )
    store.save_runtime(
        "fn-2-zeta.1", {"status": "in_progress", "assignee": "test@example.com"}
    )


def _seed_invalid_corpus(tmp_path):
    """An epic tree with a path-free integrity error set matching the golden.

    * epic depends_on_epics -> fn-99-ghost (does-not-exist).
    * task .1 depends_on -> .9 (does-not-exist) AND .2 (which depends back on
      .1, forming a cycle).
    All three error strings are path-free, so they pin against
    ``integrity_errors.txt`` byte-for-byte.
    """
    seed_state(
        tmp_path,
        epic_id="fn-1-cafe",
        title="Cafe",
        n_tasks=2,
        task_deps={1: [9, 2], 2: [1]},
    )
    # seed_state writes no epic-level deps — inject the ghost epic dep directly.
    from planctl.store import atomic_write_json, load_json

    epic_path = tmp_path / ".planctl" / "epics" / "fn-1-cafe.json"
    epic_def = load_json(epic_path)
    epic_def["depends_on_epics"] = ["fn-99-ghost"]
    atomic_write_json(epic_path, epic_def)


# ---------------------------------------------------------------------------
# show
# ---------------------------------------------------------------------------


def test_show_task_merged_runtime(tmp_path, monkeypatch):
    _seed_show_corpus(tmp_path)
    monkeypatch.chdir(tmp_path)

    result = run_cli(["show", "fn-1-cafe.1"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    env = _primary_envelope(result.output)
    assert env["success"] is True
    assert env["type"] == "task"
    t = env["task"]
    assert t["id"] == "fn-1-cafe.1"
    assert t["epic"] == "fn-1-cafe"
    assert t["status"] == "in_progress"  # merged from the state overlay
    assert t["assignee"] == "test@example.com"
    assert t["spec_path"] == "specs/fn-1-cafe.1.md"
    assert t["tier"] == "medium"
    assert t["priority"] is None
    assert t["depends_on"] == []


def test_show_epic_task_summary(tmp_path, monkeypatch):
    _seed_show_corpus(tmp_path)
    monkeypatch.chdir(tmp_path)

    result = run_cli(["show", "fn-1-cafe"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    env = _primary_envelope(result.output)
    assert env["type"] == "epic"
    e = env["epic"]
    assert e["id"] == "fn-1-cafe"
    assert e["status"] == "open"
    assert e["spec_path"] == "specs/fn-1-cafe.md"
    assert e["task_summary"] == {
        "total": 2,
        "todo": 1,
        "in_progress": 1,
        "done": 0,
        "blocked": 0,
    }


def test_show_trailer_carries_target(tmp_path, monkeypatch):
    """show rides the read-only invocation trailer with target == the id."""
    _seed_show_corpus(tmp_path)
    monkeypatch.chdir(tmp_path)
    root = str(tmp_path.resolve())

    result = run_cli(["show", "fn-1-cafe.1"], cwd=tmp_path)
    trailer = _trailer_obj(result.output)
    assert trailer is not None
    assert trailer["op"] == "show"
    assert trailer["target"] == "fn-1-cafe.1"
    assert trailer["files"] is None
    assert trailer["repo_root"] == root
    assert trailer["state_repo"] == root


def test_show_task_not_found_errors(tmp_path, monkeypatch):
    _seed_show_corpus(tmp_path)
    monkeypatch.chdir(tmp_path)

    result = run_cli(["show", "fn-1-cafe.99"], cwd=tmp_path)
    assert result.exit_code == 1
    env = _primary_envelope(result.output)
    assert env["success"] is False
    assert "Task not found" in env["error"]


def test_show_invalid_id_errors(tmp_path, monkeypatch):
    _seed_show_corpus(tmp_path)
    monkeypatch.chdir(tmp_path)

    result = run_cli(["show", "not-an-id"], cwd=tmp_path)
    assert result.exit_code == 1
    env = _primary_envelope(result.output)
    assert env["success"] is False
    assert "Invalid ID format" in env["error"]


# ---------------------------------------------------------------------------
# cat (format-free, no trailer)
# ---------------------------------------------------------------------------


def test_cat_raw_markdown_no_trailer(tmp_path, monkeypatch):
    seed_state(
        tmp_path, epic_id="fn-1-cafe", epic_spec="## Overview\nbody\n", n_tasks=1
    )
    monkeypatch.chdir(tmp_path)

    result = run_cli(["cat", "fn-1-cafe"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    assert result.output == "## Overview\nbody\n"
    assert '"planctl_invocation"' not in result.output


def test_cat_format_flag_ignored(tmp_path, monkeypatch):
    """cat is format-free: --format yaml emits the SAME raw markdown bytes."""
    seed_state(
        tmp_path, epic_id="fn-1-cafe", epic_spec="## Overview\nbody\n", n_tasks=1
    )
    monkeypatch.chdir(tmp_path)

    plain = run_cli(["cat", "fn-1-cafe"], cwd=tmp_path)
    yaml = run_cli(["--format", "yaml", "cat", "fn-1-cafe"], cwd=tmp_path)
    assert plain.exit_code == 0 and yaml.exit_code == 0
    assert plain.output == yaml.output == "## Overview\nbody\n"


def test_cat_task_spec(tmp_path, monkeypatch):
    seed_state(tmp_path, epic_id="fn-1-cafe", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    result = run_cli(["cat", "fn-1-cafe.1"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    # seed_state's per-task spec carries the seed-<i> marker in its Description.
    assert result.output.startswith("## Description\n")
    assert "## Acceptance" in result.output


def test_cat_missing_spec_errors_to_stderr(tmp_path, monkeypatch):
    seed_state(tmp_path, epic_id="fn-1-cafe", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    result = run_cli(["cat", "fn-1-cafe.9"], cwd=tmp_path)
    assert result.exit_code == 1
    assert "Spec not found" in result.output
    # Path-bearing — assert the resolved spec path is named, computed inline.
    expected = str(tmp_path.resolve() / ".planctl" / "specs" / "fn-1-cafe.9.md")
    assert expected in result.output
    assert '"planctl_invocation"' not in result.output


def test_cat_invalid_id_errors(tmp_path, monkeypatch):
    seed_state(tmp_path, epic_id="fn-1-cafe", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    result = run_cli(["cat", "garbage"], cwd=tmp_path)
    assert result.exit_code == 1
    assert "Invalid ID format" in result.output


# ---------------------------------------------------------------------------
# list (golden-pinned human renderer)
# ---------------------------------------------------------------------------


def test_list_human_golden(tmp_path, monkeypatch):
    """The list tree render is byte-pinned against the captured golden corpus."""
    _seed_list_corpus(tmp_path)
    monkeypatch.chdir(tmp_path)

    result = run_cli(["--format", "human", "list"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    primary, trailer = _split(result.output)
    assert primary == _golden("list_human.txt")
    # list takes no positional id -> trailer target is null.
    assert trailer is not None
    assert '"op":"list"' in trailer
    assert '"target":null' in trailer


def test_list_json_ordering(tmp_path, monkeypatch):
    """JSON list orders epics by number, tasks by ordinal, with merged status."""
    _seed_list_corpus(tmp_path)
    monkeypatch.chdir(tmp_path)

    result = run_cli(["list"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    env = _primary_envelope(result.output)
    epics = env["epics"]
    assert [e["id"] for e in epics] == ["fn-1-cafe", "fn-2-zeta"]
    cafe = epics[0]
    assert [t["id"] for t in cafe["tasks"]] == [
        "fn-1-cafe.1",
        "fn-1-cafe.2",
        "fn-1-cafe.3",
    ]
    assert [t["status"] for t in cafe["tasks"]] == ["todo", "in_progress", "done"]


# ---------------------------------------------------------------------------
# ready (met / unmet dep classification)
# ---------------------------------------------------------------------------


def test_ready_classifies_ready_blocked_in_progress(tmp_path, monkeypatch):
    """task .2 depends on .1 (todo) -> .2 is blocked with unmet dep .1;
    .1 is ready; a claimed task lands in in_progress."""
    from planctl.store import LocalFileStateStore

    seed_state(tmp_path, epic_id="fn-1-cafe", n_tasks=3, task_deps={2: [1], 3: []})
    LocalFileStateStore(tmp_path / ".planctl" / "state").save_runtime(
        "fn-1-cafe.3", {"status": "in_progress", "assignee": "test@example.com"}
    )
    monkeypatch.chdir(tmp_path)

    result = run_cli(["ready", "--epic", "fn-1-cafe"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    env = _primary_envelope(result.output)
    assert [t["id"] for t in env["ready"]] == ["fn-1-cafe.1"]
    assert [t["id"] for t in env["in_progress"]] == ["fn-1-cafe.3"]
    blocked = env["blocked"]
    assert [t["id"] for t in blocked] == ["fn-1-cafe.2"]
    assert blocked[0]["blocked_by"] == ["fn-1-cafe.1"]


def test_ready_met_dep_promotes_to_ready(tmp_path, monkeypatch):
    """When the dep is done, the dependent task is ready (met dep)."""
    from planctl.store import LocalFileStateStore

    seed_state(tmp_path, epic_id="fn-1-cafe", n_tasks=2, task_deps={2: [1]})
    LocalFileStateStore(tmp_path / ".planctl" / "state").save_runtime(
        "fn-1-cafe.1", {"status": "done", "assignee": "test@example.com"}
    )
    monkeypatch.chdir(tmp_path)

    result = run_cli(["ready", "--epic", "fn-1-cafe"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    env = _primary_envelope(result.output)
    assert [t["id"] for t in env["ready"]] == ["fn-1-cafe.2"]
    assert env["blocked"] == []


def test_ready_epic_not_found_errors(tmp_path, monkeypatch):
    seed_state(tmp_path, epic_id="fn-1-cafe", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    result = run_cli(["ready", "--epic", "fn-9-nope"], cwd=tmp_path)
    assert result.exit_code == 1
    env = _primary_envelope(result.output)
    assert env["success"] is False
    assert "Epic not found" in env["error"]


# ---------------------------------------------------------------------------
# tasks (filters + sort)
# ---------------------------------------------------------------------------


def test_tasks_status_filter(tmp_path, monkeypatch):
    from planctl.store import LocalFileStateStore

    seed_state(tmp_path, epic_id="fn-1-cafe", n_tasks=3)
    LocalFileStateStore(tmp_path / ".planctl" / "state").save_runtime(
        "fn-1-cafe.2", {"status": "in_progress", "assignee": "test@example.com"}
    )
    monkeypatch.chdir(tmp_path)

    result = run_cli(["tasks", "--status", "in_progress"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    env = _primary_envelope(result.output)
    assert [t["id"] for t in env["tasks"]] == ["fn-1-cafe.2"]


def test_tasks_epic_filter(tmp_path, monkeypatch):
    seed_state(tmp_path, epic_id="fn-1-cafe", n_tasks=2)
    seed_state(tmp_path, epic_id="fn-2-zeta", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    result = run_cli(["tasks", "--epic", "fn-2-zeta"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    env = _primary_envelope(result.output)
    assert [t["id"] for t in env["tasks"]] == ["fn-2-zeta.1"]


def test_tasks_sort_unparseable_id_last(tmp_path, monkeypatch):
    """Cross-epic sort by (epic_num, task_num); an unparseable epic id sorts
    last (parse_id -> 999)."""
    seed_state(tmp_path, epic_id="fn-2-zeta", n_tasks=1)
    seed_state(tmp_path, epic_id="fn-1-cafe", n_tasks=1)
    seed_state(tmp_path, epic_id="fn-zzz-weird", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    result = run_cli(["tasks"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    env = _primary_envelope(result.output)
    assert [t["id"] for t in env["tasks"]] == [
        "fn-1-cafe.1",
        "fn-2-zeta.1",
        "fn-zzz-weird.1",
    ]


def test_tasks_no_trailer_target(tmp_path, monkeypatch):
    """tasks takes no positional id -> trailer target is null."""
    seed_state(tmp_path, epic_id="fn-1-cafe", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    result = run_cli(["tasks"], cwd=tmp_path)
    trailer = _trailer_obj(result.output)
    assert trailer is not None
    assert trailer["op"] == "tasks"
    assert trailer["target"] is None


# ---------------------------------------------------------------------------
# resolve-task (typed errors, null tier, target_repo fallback, multi-project)
# ---------------------------------------------------------------------------


@pytest.mark.real_roots
def test_resolve_task_null_tier_and_fallback(tmp_path, monkeypatch, request):
    """A tier-less task surfaces tier == explicit JSON null; target_repo /
    primary_repo fall back to the resolved project path (3-level fallback)."""
    # Isolate discovery to a fresh root holding ONLY this project, so the roots
    # scan can't collide with sibling pytest tmp dirs that also carry fn-1-cafe.
    root = tmp_path / "_root"
    proj = root / "proj"
    proj.mkdir(parents=True)
    seed_state(proj, epic_id="fn-1-cafe", n_tasks=1)
    # seed_state defaults tier to "medium"; null it on disk to exercise the
    # explicit-null tier surface.
    from planctl.store import atomic_write_json, load_json

    task_path = proj / ".planctl" / "tasks" / "fn-1-cafe.1.json"
    task_def = load_json(task_path)
    task_def["tier"] = None
    atomic_write_json(task_path, task_def)
    set_roots(request, monkeypatch, [root])
    monkeypatch.chdir(proj)

    result = run_cli(["resolve-task", "fn-1-cafe.1"], cwd=proj)
    assert result.exit_code == 0, result.output
    env = _primary_envelope(result.output)
    assert env["success"] is True
    assert env["task_id"] == "fn-1-cafe.1"
    assert env["epic_id"] == "fn-1-cafe"
    assert env["tier"] is None  # explicit null, not omitted
    assert "tier" in env
    assert env["worker_agent"] is None
    assert env["status"] == "todo"
    proj_root = str(proj.resolve())
    assert env["project_path"] == proj_root
    assert env["target_repo"] == proj_root
    assert env["primary_repo"] == proj_root


def test_resolve_task_bad_id(tmp_path, monkeypatch):
    seed_state(tmp_path, epic_id="fn-1-cafe", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    result = run_cli(["resolve-task", "not-an-id"], cwd=tmp_path)
    assert result.exit_code == 1
    env = _primary_envelope(result.output)
    assert env["success"] is False
    assert env["error"]["code"] == "BAD_TASK_ID"


def test_resolve_task_not_a_project(tmp_path, monkeypatch):
    """--project pointing at a non-planctl dir -> NOT_A_PROJECT."""
    seed_state(tmp_path, epic_id="fn-1-cafe", n_tasks=1)
    bare = tmp_path.parent / "bare_dir"
    bare.mkdir()
    monkeypatch.chdir(tmp_path)

    result = run_cli(
        ["resolve-task", "fn-1-cafe.1", "--project", str(bare)], cwd=tmp_path
    )
    assert result.exit_code == 1
    env = _primary_envelope(result.output)
    assert env["error"]["code"] == "NOT_A_PROJECT"


def test_resolve_task_not_found_via_project(tmp_path, monkeypatch):
    seed_state(tmp_path, epic_id="fn-1-cafe", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    result = run_cli(
        ["resolve-task", "fn-1-cafe.9", "--project", str(tmp_path)], cwd=tmp_path
    )
    assert result.exit_code == 1
    env = _primary_envelope(result.output)
    assert env["error"]["code"] == "TASK_NOT_FOUND"


@pytest.mark.real_roots
def test_resolve_task_ambiguous_multi_project(tmp_path, monkeypatch, request):
    """The same task id seeded into two project dirs under one root -> the
    roots scan finds both and surfaces AMBIGUOUS_TASK_ID with both candidates."""
    proj_a = tmp_path / "a"
    proj_b = tmp_path / "b"
    proj_a.mkdir()
    proj_b.mkdir()
    seed_state(proj_a, epic_id="fn-1-cafe", n_tasks=1)
    seed_state(proj_b, epic_id="fn-1-cafe", n_tasks=1)
    set_roots(request, monkeypatch, [tmp_path])
    monkeypatch.chdir(tmp_path)

    result = run_cli(["resolve-task", "fn-1-cafe.1"], cwd=tmp_path)
    assert result.exit_code == 1
    env = _primary_envelope(result.output)
    assert env["error"]["code"] == "AMBIGUOUS_TASK_ID"
    candidates = env["error"]["details"]["candidates"]
    assert {str(proj_a.resolve()), str(proj_b.resolve())} == set(candidates)


@pytest.mark.real_roots
def test_resolve_task_project_disambiguates(tmp_path, monkeypatch, request):
    """--project resolves cleanly past a multi-project collision."""
    proj_a = tmp_path / "a"
    proj_b = tmp_path / "b"
    proj_a.mkdir()
    proj_b.mkdir()
    seed_state(proj_a, epic_id="fn-1-cafe", n_tasks=1)
    seed_state(proj_b, epic_id="fn-1-cafe", n_tasks=1)
    set_roots(request, monkeypatch, [tmp_path])
    monkeypatch.chdir(tmp_path)

    result = run_cli(
        ["resolve-task", "fn-1-cafe.1", "--project", str(proj_b)], cwd=tmp_path
    )
    assert result.exit_code == 0, result.output
    env = _primary_envelope(result.output)
    assert env["success"] is True
    assert env["project_path"] == str(proj_b.resolve())


# ---------------------------------------------------------------------------
# refine-context (read path)
# ---------------------------------------------------------------------------


def test_refine_context_read_envelope(tmp_path, monkeypatch):
    seed_state(
        tmp_path,
        epic_id="fn-1-cafe",
        title="Cafe",
        epic_spec="## Overview\nepic body\n",
        n_tasks=2,
    )
    monkeypatch.chdir(tmp_path)

    result = run_cli(["refine-context", "fn-1-cafe"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    env = _primary_envelope(result.output)
    assert env["epic_id"] == "fn-1-cafe"
    assert env["title"] == "Cafe"
    assert env["epic_spec_md"] == "## Overview\nepic body\n"
    assert env["last_validated_at"] is None
    tasks = env["tasks"]
    assert [t["id"] for t in tasks] == ["fn-1-cafe.1", "fn-1-cafe.2"]
    assert tasks[0]["spec_md"].startswith("## Description\n")


def test_refine_context_empty_spec_string(tmp_path, monkeypatch):
    """A spec-less epic returns epic_spec_md == "" (empty string, not null)."""
    seed_state(tmp_path, epic_id="fn-1-cafe", n_tasks=0)
    # Remove the epic spec file to exercise the absent-spec branch.
    (tmp_path / ".planctl" / "specs" / "fn-1-cafe.md").unlink()
    monkeypatch.chdir(tmp_path)

    result = run_cli(["refine-context", "fn-1-cafe"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    env = _primary_envelope(result.output)
    assert env["epic_spec_md"] == ""
    assert env["tasks"] == []


def test_refine_context_bad_id(tmp_path, monkeypatch):
    seed_state(tmp_path, epic_id="fn-1-cafe", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    result = run_cli(["refine-context", "fn-1-cafe.1"], cwd=tmp_path)
    assert result.exit_code == 1
    env = _primary_envelope(result.output)
    assert env["error"]["code"] == "BAD_EPIC_ID"


def test_refine_context_epic_not_found(tmp_path, monkeypatch):
    seed_state(tmp_path, epic_id="fn-1-cafe", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    result = run_cli(["refine-context", "fn-9-nope"], cwd=tmp_path)
    assert result.exit_code == 1
    env = _primary_envelope(result.output)
    assert env["error"]["code"] == "EPIC_NOT_FOUND"


# ---------------------------------------------------------------------------
# validate (whole-project) — golden-pinned error catalog, no trailer
# ---------------------------------------------------------------------------


def test_validate_valid_project(tmp_path, monkeypatch):
    seed_state(tmp_path, epic_id="fn-1-cafe", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    result = run_cli(["validate"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    primary, trailer = _split(result.output)
    env = json.loads(primary)
    assert env == {"valid": True, "errors": [], "warnings": []}
    # validate is a NO-trailer verb.
    assert trailer is None


def test_validate_invalid_error_catalog_golden(tmp_path, monkeypatch):
    """Whole-project validate over an invalid tree: exit 1, {valid,errors,
    warnings} envelope, NO trailer, and the error catalog byte-pinned against
    the captured golden (path-free errors)."""
    _seed_invalid_corpus(tmp_path)
    monkeypatch.chdir(tmp_path)

    result = run_cli(["validate"], cwd=tmp_path)
    assert result.exit_code == 1
    primary, trailer = _split(result.output)
    assert trailer is None
    env = json.loads(primary)
    assert env["valid"] is False
    assert env["warnings"] == []
    expected_errors = _golden("integrity_errors.txt").splitlines()
    assert env["errors"] == expected_errors


def test_validate_touched_repos_warning_repr_quoted(tmp_path, monkeypatch):
    """The target_repo-not-in-touched_repos warning uses Python repr quoting
    (``{x!r}``) around the path — a path-bearing string asserted dynamically."""
    other = tmp_path.parent / "other_repo"
    other.mkdir()
    (other / ".git").mkdir()
    seed_state(tmp_path, epic_id="fn-1-cafe", n_tasks=1, primary_repo=str(tmp_path))
    # Give the epic a touched_repos that EXCLUDES the task's target_repo, and
    # point the task at `other` so the coverage warning fires.
    from planctl.store import atomic_write_json, load_json

    (tmp_path / ".git").mkdir(exist_ok=True)
    epic_path = tmp_path / ".planctl" / "epics" / "fn-1-cafe.json"
    epic_def = load_json(epic_path)
    epic_def["touched_repos"] = [str(tmp_path)]
    atomic_write_json(epic_path, epic_def)
    task_path = tmp_path / ".planctl" / "tasks" / "fn-1-cafe.1.json"
    task_def = load_json(task_path)
    task_def["target_repo"] = str(other)
    atomic_write_json(task_path, task_def)
    monkeypatch.chdir(tmp_path)

    result = run_cli(["validate"], cwd=tmp_path)
    primary, _ = _split(result.output)
    env = json.loads(primary)
    warning = (
        f"Task fn-1-cafe.1: target_repo {str(other)!r} is not in "
        f"epic.touched_repos — this may indicate a misconfiguration"
    )
    assert warning in env["warnings"]


# ---------------------------------------------------------------------------
# validate --epic (stamp state-machine)
# ---------------------------------------------------------------------------


def test_validate_epic_stamps_on_none_transition(tmp_path, monkeypatch, fixed_clock):
    """validate --epic on a None marker: writes last_validated_at == frozen
    clock, prints a SECOND compact planctl_invocation line (op=validate,
    target=epic). The stamp equals the frozen PLANCTL_NOW value."""
    from planctl.store import load_json

    seed_state(tmp_path, epic_id="fn-1-cafe", n_tasks=1)
    epic_path = tmp_path / ".planctl" / "epics" / "fn-1-cafe.json"
    assert load_json(epic_path).get("last_validated_at") is None
    monkeypatch.chdir(tmp_path)

    result = run_cli(["validate", "--epic", "fn-1-cafe"], cwd=tmp_path)
    assert result.exit_code == 0, result.output
    primary, trailer = _split(result.output)
    env = json.loads(primary)
    assert env["valid"] is True
    # Second compact invocation line present, naming the epic.
    assert trailer is not None
    inv = json.loads(trailer)["planctl_invocation"]
    assert inv["op"] == "validate"
    assert inv["target"] == "fn-1-cafe"
    # Stamp equals the frozen clock.
    assert load_json(epic_path)["last_validated_at"] == fixed_clock


def test_validate_epic_already_stamped_is_noop(tmp_path, monkeypatch, fixed_clock):
    """A second validate --epic on an already-stamped epic is a pure no-op:
    same envelope, NO second invocation line, marker unchanged."""
    from planctl.store import load_json

    seed_state(tmp_path, epic_id="fn-1-cafe", n_tasks=1)
    epic_path = tmp_path / ".planctl" / "epics" / "fn-1-cafe.json"
    monkeypatch.chdir(tmp_path)

    first = run_cli(["validate", "--epic", "fn-1-cafe"], cwd=tmp_path)
    assert first.exit_code == 0, first.output
    stamped = load_json(epic_path)["last_validated_at"]
    assert stamped == fixed_clock

    second = run_cli(["validate", "--epic", "fn-1-cafe"], cwd=tmp_path)
    assert second.exit_code == 0, second.output
    primary, trailer = _split(second.output)
    json.loads(primary)  # parses as the {valid,...} envelope
    # No second invocation line on the no-op re-run.
    assert trailer is None
    # Marker unchanged.
    assert load_json(epic_path)["last_validated_at"] == stamped
