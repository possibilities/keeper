"""Tests for the fn-513 spec-metadata setter verbs.

Verbs under test:
- planctl task set-snippets <task_id> --snippets a,b,c
- planctl task set-bundles <task_id> --bundles ref1,ref2
- planctl epic set-snippets <epic_id> --snippets a,b,c
- planctl epic set-bundles <epic_id> --bundles ref1,ref2

Per verb: success path; empty string clears; replace replaces (not appends);
regex rejects path-traversal / bad shapes; envelope shape (planctl_invocation
present); VALIDATION_CLEAR side-effect (last_validated_at cleared). `show`
JSON + human output includes the new fields when set, omits the human row
when empty.
"""

from __future__ import annotations

import json
import os

from click.testing import CliRunner  # type: ignore[import-untyped]
from planctl.cli import cli

from .conftest import run_cli

_ENV = {**os.environ, "CLAUDE_CODE_SESSION_ID": "test-set-snippets-bundles-fixture"}


def _create_project(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-set-snippets-bundles-fixture")
    monkeypatch.chdir(tmp_path)
    runner = CliRunner()
    result = runner.invoke(cli, ["init"])
    assert result.exit_code == 0, result.output
    return tmp_path


def _create_epic(project_path) -> str:
    runner = CliRunner()
    result = runner.invoke(
        cli,
        ["epic", "create", "--title", "Snippet metadata test epic"],
        env=_ENV,
    )
    assert result.exit_code == 0, result.output
    epic_id = json.loads(result.output.strip())["epic"]["id"]

    # Null multi-repo fields so the test dir (no .git/) does not trip validate.
    epic_path = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    data = json.loads(epic_path.read_text())
    data["primary_repo"] = None
    data["touched_repos"] = None
    epic_path.write_text(json.dumps(data))
    return epic_id


def _create_task(project_path, epic_id) -> str:
    from .conftest import add_task

    return add_task(project_path, epic_id, title="Snippet test task", env=_ENV)


def _run(args: list[str], cwd: str):
    return run_cli(args, cwd=cwd, env=_ENV)


def _read_task_json(project_path, task_id) -> dict:
    return json.loads(
        (project_path / ".planctl" / "tasks" / f"{task_id}.json").read_text()
    )


def _read_epic_json(project_path, epic_id) -> dict:
    return json.loads(
        (project_path / ".planctl" / "epics" / f"{epic_id}.json").read_text()
    )


def _stamp_marker(project_path, epic_id, ts="2020-01-01T00:00:00Z") -> None:
    epic_path = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    data = json.loads(epic_path.read_text())
    data["last_validated_at"] = ts
    epic_path.write_text(json.dumps(data))


def _parse_json_stream(text: str) -> list[dict]:
    """Extract every JSON document from stdout.

    Mutating verbs emit one single-line NDJSON doc (the envelope, with
    ``planctl_invocation`` embedded).  ``show`` emits a pretty-printed
    multi-line JSON doc followed by a trailing single-line invocation doc.
    Both shapes are handled by a raw_decode scan.
    """
    decoder = json.JSONDecoder()
    docs: list[dict] = []
    idx = 0
    while idx < len(text):
        while idx < len(text) and text[idx] in " \t\n\r":
            idx += 1
        if idx >= len(text):
            break
        obj, end = decoder.raw_decode(text, idx)
        docs.append(obj)
        idx = end
    return docs


def _envelope(result) -> dict:
    """First JSON doc on stdout (the mutating-verb envelope)."""
    return _parse_json_stream(result.stdout)[0]


def _invocation(result) -> dict | None:
    for doc in _parse_json_stream(result.stdout):
        if "planctl_invocation" in doc:
            return doc["planctl_invocation"]
    return None


# ---------------------------------------------------------------------------
# task set-snippets
# ---------------------------------------------------------------------------


def test_task_set_snippets_success(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)
    task_id = _create_task(project_path, epic_id)

    result = _run(
        ["task", "set-snippets", task_id, "--snippets", "api-py-pattern,boundary-lint"],
        cwd=str(project_path),
    )
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"

    task_data = _read_task_json(project_path, task_id)
    assert task_data["snippets"] == ["api-py-pattern", "boundary-lint"]

    env = _envelope(result)
    assert env["snippets"] == ["api-py-pattern", "boundary-lint"]
    assert env["task_id"] == task_id


def test_task_set_snippets_empty_clears(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)
    task_id = _create_task(project_path, epic_id)

    _run(
        ["task", "set-snippets", task_id, "--snippets", "a,b,c"],
        cwd=str(project_path),
    )
    result = _run(
        ["task", "set-snippets", task_id, "--snippets", ""],
        cwd=str(project_path),
    )
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert _read_task_json(project_path, task_id)["snippets"] == []

    # Omitting --snippets entirely also clears (default="").
    _run(["task", "set-snippets", task_id, "--snippets", "x"], cwd=str(project_path))
    result2 = _run(["task", "set-snippets", task_id], cwd=str(project_path))
    assert result2.returncode == 0, f"{result2.stdout}\n{result2.stderr}"
    assert _read_task_json(project_path, task_id)["snippets"] == []


def test_task_set_snippets_replaces_not_appends(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)
    task_id = _create_task(project_path, epic_id)

    _run(["task", "set-snippets", task_id, "--snippets", "a,b"], cwd=str(project_path))
    _run(["task", "set-snippets", task_id, "--snippets", "c"], cwd=str(project_path))
    assert _read_task_json(project_path, task_id)["snippets"] == ["c"]


def test_task_set_snippets_rejects_bad_id(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)
    task_id = _create_task(project_path, epic_id)

    # Uppercase / path-traversal-ish / empty segments are rejected.
    for bad in ["Bad-Id", "../etc", "a/b", "a--b", "-lead", "trail-"]:
        result = _run(
            ["task", "set-snippets", task_id, "--snippets", bad],
            cwd=str(project_path),
        )
        assert result.returncode != 0, f"Expected reject for {bad!r}: {result.stdout}"
    # The list was never written (key absent on a never-set task → []).
    assert _read_task_json(project_path, task_id).get("snippets", []) == []


def test_task_set_snippets_restamps_epic_marker(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)
    task_id = _create_task(project_path, epic_id)
    _stamp_marker(project_path, epic_id)

    result = _run(
        ["task", "set-snippets", task_id, "--snippets", "x"],
        cwd=str(project_path),
    )
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    _marker = _read_epic_json(project_path, epic_id)["last_validated_at"]
    assert isinstance(_marker, str) and _marker > "2020-01-01T00:00:00Z", _marker


def test_task_set_snippets_emits_invocation(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)
    task_id = _create_task(project_path, epic_id)

    result = _run(
        ["task", "set-snippets", task_id, "--snippets", "x"],
        cwd=str(project_path),
    )
    assert result.returncode == 0
    inv = _invocation(result)
    assert inv is not None, f"No planctl_invocation in: {result.stdout!r}"
    assert inv.get("op") == "set-snippets"
    assert inv.get("target") == task_id


# ---------------------------------------------------------------------------
# task set-bundles
# ---------------------------------------------------------------------------


def test_task_set_bundles_success(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)
    task_id = _create_task(project_path, epic_id)

    # fn-610: ``sketch/`` refs now resolve at write time and inline their
    # snippet ids into the persisted ``snippets``; the ref is dropped from
    # ``bundles``. Test only the ``bundle/`` + ``arc/`` passthrough here;
    # the sketch-inlining happy path lives in
    # ``test_cross_project_sketch_inline.py``.
    result = _run(
        [
            "task",
            "set-bundles",
            task_id,
            "--bundles",
            "bundle/dev-env,arc/snippeting/main",
        ],
        cwd=str(project_path),
    )
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert _read_task_json(project_path, task_id)["bundles"] == [
        "bundle/dev-env",
        "arc/snippeting/main",
    ]


def test_task_set_bundles_empty_clears(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)
    task_id = _create_task(project_path, epic_id)

    _run(
        ["task", "set-bundles", task_id, "--bundles", "bundle/dev-env"],
        cwd=str(project_path),
    )
    result = _run(
        ["task", "set-bundles", task_id, "--bundles", ""],
        cwd=str(project_path),
    )
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert _read_task_json(project_path, task_id)["bundles"] == []


def test_task_set_bundles_replaces_not_appends(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)
    task_id = _create_task(project_path, epic_id)

    _run(
        ["task", "set-bundles", task_id, "--bundles", "bundle/a,bundle/b"],
        cwd=str(project_path),
    )
    _run(
        ["task", "set-bundles", task_id, "--bundles", "arc/x/y"],
        cwd=str(project_path),
    )
    assert _read_task_json(project_path, task_id)["bundles"] == ["arc/x/y"]


def test_task_set_bundles_rejects_path_traversal(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)
    task_id = _create_task(project_path, epic_id)

    for bad in [
        "arc/foo/../etc",
        "bundle/",
        "Bundle/Dev",
        "ftp/x",
        "arc/a/b/c",
        "/abs/path",
        "bundle/UPPER",
    ]:
        result = _run(
            ["task", "set-bundles", task_id, "--bundles", bad],
            cwd=str(project_path),
        )
        assert result.returncode != 0, f"Expected reject for {bad!r}: {result.stdout}"
    assert _read_task_json(project_path, task_id).get("bundles", []) == []


def test_task_set_bundles_restamps_epic_marker(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)
    task_id = _create_task(project_path, epic_id)
    _stamp_marker(project_path, epic_id)

    result = _run(
        ["task", "set-bundles", task_id, "--bundles", "bundle/dev-env"],
        cwd=str(project_path),
    )
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    _marker = _read_epic_json(project_path, epic_id)["last_validated_at"]
    assert isinstance(_marker, str) and _marker > "2020-01-01T00:00:00Z", _marker


# ---------------------------------------------------------------------------
# epic set-snippets / set-bundles
# ---------------------------------------------------------------------------


def test_epic_set_snippets_success_and_marker(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)
    _stamp_marker(project_path, epic_id)

    result = _run(
        ["epic", "set-snippets", epic_id, "--snippets", "a-one,b-two"],
        cwd=str(project_path),
    )
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    epic_data = _read_epic_json(project_path, epic_id)
    assert epic_data["snippets"] == ["a-one", "b-two"]
    assert (
        isinstance(epic_data["last_validated_at"], str)
        and epic_data["last_validated_at"] > "2020-01-01T00:00:00Z"
    ), epic_data["last_validated_at"]

    env = _envelope(result)
    assert env["snippets"] == ["a-one", "b-two"]


def test_epic_set_snippets_empty_clears(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)

    _run(["epic", "set-snippets", epic_id, "--snippets", "x,y"], cwd=str(project_path))
    result = _run(
        ["epic", "set-snippets", epic_id, "--snippets", ""],
        cwd=str(project_path),
    )
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert _read_epic_json(project_path, epic_id)["snippets"] == []


def test_epic_set_bundles_success_and_marker(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)
    _stamp_marker(project_path, epic_id)

    result = _run(
        ["epic", "set-bundles", epic_id, "--bundles", "arc/snippeting/main"],
        cwd=str(project_path),
    )
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    epic_data = _read_epic_json(project_path, epic_id)
    assert epic_data["bundles"] == ["arc/snippeting/main"]
    assert (
        isinstance(epic_data["last_validated_at"], str)
        and epic_data["last_validated_at"] > "2020-01-01T00:00:00Z"
    ), epic_data["last_validated_at"]


def test_epic_set_bundles_rejects_path_traversal(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)

    result = _run(
        ["epic", "set-bundles", epic_id, "--bundles", "arc/foo/../etc"],
        cwd=str(project_path),
    )
    assert result.returncode != 0, f"Expected reject: {result.stdout}"
    assert _read_epic_json(project_path, epic_id).get("bundles", []) == []


def test_epic_set_bundles_emits_invocation(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)

    result = _run(
        ["epic", "set-bundles", epic_id, "--bundles", "bundle/dev-env"],
        cwd=str(project_path),
    )
    assert result.returncode == 0
    inv = _invocation(result)
    assert inv is not None, f"No planctl_invocation in: {result.stdout!r}"
    assert inv.get("op") == "set-bundles"
    assert inv.get("target") == epic_id


# ---------------------------------------------------------------------------
# show surfaces the new fields (JSON + human)
# ---------------------------------------------------------------------------


def test_show_task_surfaces_snippets_bundles(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)
    task_id = _create_task(project_path, epic_id)

    _run(
        ["task", "set-snippets", task_id, "--snippets", "snip-one"],
        cwd=str(project_path),
    )
    _run(
        ["task", "set-bundles", task_id, "--bundles", "bundle/dev-env"],
        cwd=str(project_path),
    )

    # JSON (pretty-printed doc + trailing invocation doc).
    result = _run(["show", task_id], cwd=str(project_path))
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    payload = _parse_json_stream(result.stdout)[0]
    assert payload["task"]["snippets"] == ["snip-one"]
    assert payload["task"]["bundles"] == ["bundle/dev-env"]

    # Human.
    human = _run(
        ["show", task_id, "--format", "human"],
        cwd=str(project_path),
    )
    assert human.returncode == 0, f"{human.stdout}\n{human.stderr}"
    assert "Snippets: snip-one" in human.stdout
    assert "Bundles: bundle/dev-env" in human.stdout


def test_show_task_omits_human_rows_when_empty(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)
    task_id = _create_task(project_path, epic_id)

    human = _run(
        ["show", task_id, "--format", "human"],
        cwd=str(project_path),
    )
    assert human.returncode == 0, f"{human.stdout}\n{human.stderr}"
    assert "Snippets:" not in human.stdout
    assert "Bundles:" not in human.stdout

    # JSON still carries the empty lists.
    result = _run(["show", task_id], cwd=str(project_path))
    payload = _parse_json_stream(result.stdout)[0]
    assert payload["task"]["snippets"] == []
    assert payload["task"]["bundles"] == []


def test_show_epic_surfaces_snippets_bundles(tmp_path, monkeypatch):
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)

    _run(
        ["epic", "set-snippets", epic_id, "--snippets", "epic-snip"],
        cwd=str(project_path),
    )
    _run(
        ["epic", "set-bundles", epic_id, "--bundles", "arc/snippeting/main"],
        cwd=str(project_path),
    )

    result = _run(["show", epic_id], cwd=str(project_path))
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    payload = _parse_json_stream(result.stdout)[0]
    assert payload["epic"]["snippets"] == ["epic-snip"]
    assert payload["epic"]["bundles"] == ["arc/snippeting/main"]

    human = _run(
        ["show", epic_id, "--format", "human"],
        cwd=str(project_path),
    )
    assert human.returncode == 0, f"{human.stdout}\n{human.stderr}"
    assert "Snippets: epic-snip" in human.stdout
    assert "Bundles: arc/snippeting/main" in human.stdout
