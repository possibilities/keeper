"""Tests for the _NO_TRACK_COMMANDS allow-list in InvocationTrackedGroup.

Verifies that ``planctl cat`` and ``planctl validate`` bypass the invocation
decorator entirely, keeping their stdout contracts clean:
- ``cat`` emits raw markdown byte-for-byte identical to the spec file on disk.
- ``validate`` emits {valid, errors, warnings} as doc 1; on first-ever valid
  run of --epic <id>, also emits a planctl_invocation doc as doc 2.

Both tests use subprocess.check_output to assert on RAW stdout — not filtered
through parse_cli_output, which strips the trailing invocation line.
"""

from __future__ import annotations

import json
import os
import subprocess

from click.testing import CliRunner
from planctl.cli import cli


def _parse_json_stream(text: str) -> list[dict]:
    """Extract all JSON objects from a string that may contain pretty-printed
    or compact JSON documents concatenated together (NDJSON or multi-line JSON)."""
    decoder = json.JSONDecoder()
    docs = []
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


def _create_project(tmp_path, monkeypatch):
    """Init a planctl project in tmp_path and return the path."""
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-no-track-fixture")
    monkeypatch.chdir(tmp_path)
    runner = CliRunner()
    result = runner.invoke(cli, ["init"])
    assert result.exit_code == 0, result.output
    return tmp_path


def _create_epic(project_path) -> str:
    """Create an epic and return its ID.

    Nulls out primary_repo and touched_repos so validate treats it as a legacy
    epic — the test project dir has no .git/ and new-style path validation would
    fail otherwise.
    """
    runner = CliRunner()
    env = {**os.environ, "CLAUDE_CODE_SESSION_ID": "test-no-track-fixture"}
    result = runner.invoke(
        cli,
        ["epic", "create", "--title", "No-track test epic"],
        env=env,
    )
    assert result.exit_code == 0, result.output
    epic_id = json.loads(result.output.strip())["epic"]["id"]

    # Null out multi-repo fields so validate treats this as a legacy epic.
    epic_path = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    data = json.loads(epic_path.read_text())
    data["primary_repo"] = None
    data["touched_repos"] = None
    epic_path.write_text(json.dumps(data))

    return epic_id


def test_cat_stdout_is_pure_markdown(tmp_path, monkeypatch):
    """planctl cat <epic_id> stdout must be byte-for-byte identical to the spec file.

    No trailing JSON line, no extra newlines — pure raw markdown.
    """
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)

    spec_path = project_path / ".planctl" / "specs" / f"{epic_id}.md"
    assert spec_path.exists(), f"Spec file not found: {spec_path}"

    expected = spec_path.read_bytes()

    env = {**os.environ, "CLAUDE_CODE_SESSION_ID": "test-no-track-fixture"}
    actual = subprocess.check_output(
        ["planctl", "cat", epic_id],
        cwd=str(project_path),
        env=env,
    )

    assert actual == expected, (
        f"planctl cat stdout does not match raw spec file.\n"
        f"Expected ({len(expected)} bytes):\n{expected!r}\n"
        f"Got ({len(actual)} bytes):\n{actual!r}"
    )


def test_validate_stdout_contract(tmp_path, monkeypatch):
    """planctl validate --epic <epic_id> stdout contract.

    Doc 1: {valid, errors, warnings} envelope.
    Doc 2 (only when valid=True AND the epic was never previously validated):
        {"planctl_invocation": {...}} NDJSON envelope.

    Re-validating an already-stamped epic produces only doc 1 (no second doc).
    """
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)

    env = {**os.environ, "CLAUDE_CODE_SESSION_ID": "test-no-track-fixture"}

    # First validate: never-validated epic, structurally valid → two JSON docs.
    raw = subprocess.check_output(
        ["planctl", "validate", "--epic", epic_id],
        cwd=str(project_path),
        env=env,
    ).decode("utf-8")

    docs = _parse_json_stream(raw)
    assert len(docs) >= 1, f"Expected at least 1 JSON doc, got: {raw!r}"

    doc1 = docs[0]
    assert "valid" in doc1, f"Missing 'valid' key in doc1: {doc1}"
    assert "errors" in doc1, f"Missing 'errors' key in doc1: {doc1}"
    assert "warnings" in doc1, f"Missing 'warnings' key in doc1: {doc1}"

    if doc1.get("valid"):
        # Expect a second JSON doc with the invocation envelope.
        assert len(docs) == 2, (
            f"Expected 2 JSON docs on first valid validate, got {len(docs)}: {raw!r}"
        )
        doc2 = docs[1]
        assert "planctl_invocation" in doc2, (
            f"Missing 'planctl_invocation' key in doc2: {doc2}"
        )

        # Second validate: already-stamped → only one doc (no invocation).
        raw2 = subprocess.check_output(
            ["planctl", "validate", "--epic", epic_id],
            cwd=str(project_path),
            env=env,
        ).decode("utf-8")
        docs2 = _parse_json_stream(raw2)
        assert len(docs2) == 1, (
            f"Expected 1 JSON doc on re-validate of already-stamped epic, "
            f"got {len(docs2)}: {raw2!r}"
        )
        assert docs2[0].get("valid") is True, (
            f"Re-validate should still be valid: {docs2[0]}"
        )
    else:
        # Invalid epic → only one doc.
        assert len(docs) == 1, (
            f"Expected 1 JSON doc on invalid validate, got {len(docs)}: {raw!r}"
        )
