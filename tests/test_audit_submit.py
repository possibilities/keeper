"""Tests for `planctl audit submit <epic_id>` (fn-12 task .2).

The audit-submit verb persists the content-blind quality-auditor's report
markdown commit-free under `audits/<epic_id>/report.md` (plus a `report.meta.json`
sidecar), stamped with the brief's `commit_set_hash` + `schema_version`, and
echoes the report handle + the `--findings` / `--risk` flags in a content-blind
envelope.

Coverage (per the task's Test notes):
- happy path persists report + meta and the envelope carries the handle + flags
- the persisted record stamps the brief's hash
- no `.planctl/` commit fires (the artifact lives under gitignored state/)
- reject paths: missing brief, oversize stdin, bad --risk, task-shaped id
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from click.testing import CliRunner
from planctl.audit_artifacts import brief_path, compute_commit_set_hash, write_artifact
from planctl.cli import cli

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _envelope(output: str) -> dict:
    """Parse the first JSON object in stdout carrying a payload/error key."""
    payload_keys = ("success", "error", "report_ref", "verdict_ref", "followup_ref")
    decoder = json.JSONDecoder()
    idx = 0
    while idx < len(output):
        brace = output.find("{", idx)
        if brace == -1:
            break
        try:
            obj, end = decoder.raw_decode(output, brace)
        except json.JSONDecodeError:
            idx = brace + 1
            continue
        if any(k in obj for k in payload_keys):
            return obj
        idx = end
    raise AssertionError(f"no envelope found in {output!r}")


def _seed_brief(project: Path, epic_id: str, *, commit_set_hash: str | None = None):
    """Write an `audits/<epic_id>/brief.json` directly (skips close-preflight).

    Returns the stamped `commit_set_hash`. Keeps the submit tests hermetic — they
    exercise the submit verb, not preflight's commit-trailer scan.
    """
    if commit_set_hash is None:
        commit_set_hash = compute_commit_set_hash(
            [{"repo": str(project), "shas": ["abc123"]}]
        )
    brief = {
        "schema_version": 1,
        "epic_id": epic_id,
        "primary_repo": str(project),
        "commit_set_hash": commit_set_hash,
        "commit_groups": [],
        "snippet_context": "",
        "tasks": [],
    }
    write_artifact(brief_path(project, epic_id), json.dumps(brief) + "\n")
    return commit_set_hash


_EID = "fn-7-demo-epic"


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_happy_path_persists_report_and_meta(project):
    h = _seed_brief(project, _EID)
    r = CliRunner().invoke(
        cli,
        ["audit", "submit", _EID, "--file", "-", "--findings", "3", "--risk", "Medium"],
        input="# Audit report\n\nNo fatal findings.\n",
    )
    assert r.exit_code == 0, r.output
    env = _envelope(r.output)
    assert env["success"] is True
    assert env["findings"] == 3
    assert env["risk"] == "Medium"
    assert env["commit_set_hash"] == h

    report = Path(env["report_ref"])
    meta = Path(env["meta_ref"])
    assert report.read_text() == "# Audit report\n\nNo fatal findings.\n"
    meta_obj = json.loads(meta.read_text())
    assert meta_obj["commit_set_hash"] == h
    assert meta_obj["schema_version"] == 1
    assert meta_obj["findings"] == 3
    assert meta_obj["risk"] == "Medium"


def test_meta_stamps_hash_from_brief(project):
    """A submit stamps the brief's hash, not a recomputed one."""
    custom = "deadbeef" * 8
    _seed_brief(project, _EID, commit_set_hash=custom)
    r = CliRunner().invoke(
        cli,
        ["audit", "submit", _EID, "--file", "-", "--risk", "Low"],
        input="report\n",
    )
    assert r.exit_code == 0, r.output
    assert _envelope(r.output)["commit_set_hash"] == custom


def test_last_writer_wins(project):
    _seed_brief(project, _EID)
    runner = CliRunner()
    runner.invoke(
        cli, ["audit", "submit", _EID, "--file", "-", "--risk", "Low"], input="v1\n"
    )
    r = runner.invoke(
        cli, ["audit", "submit", _EID, "--file", "-", "--risk", "High"], input="v2\n"
    )
    assert r.exit_code == 0, r.output
    assert Path(_envelope(r.output)["report_ref"]).read_text() == "v2\n"


# ---------------------------------------------------------------------------
# Commit-free: the artifact draws no .planctl/ commit
# ---------------------------------------------------------------------------


@pytest.mark.real_git
def test_no_commit_fires(project):
    """The submit mutates only gitignored state/ — no commit, clean worktree."""
    _seed_brief(project, _EID)
    head_before = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=project, capture_output=True, text=True
    ).stdout.strip()
    r = CliRunner().invoke(
        cli, ["audit", "submit", _EID, "--file", "-", "--risk", "Low"], input="rep\n"
    )
    assert r.exit_code == 0, r.output
    head_after = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=project, capture_output=True, text=True
    ).stdout.strip()
    assert head_after == head_before
    # No NDJSON planctl_invocation line with non-null files (no commit payload).
    assert '"files":[' not in r.output


# ---------------------------------------------------------------------------
# Reject paths
# ---------------------------------------------------------------------------


def test_missing_brief_rejects(project):
    r = CliRunner().invoke(
        cli, ["audit", "submit", _EID, "--file", "-", "--risk", "Low"], input="x\n"
    )
    assert r.exit_code == 1
    env = _envelope(r.output)
    assert env["error"]["code"] == "BRIEF_MISSING"
    # The remediation hint must name the real epic id, not the literal token.
    msg = env["error"]["message"]
    assert _EID in msg
    assert "{epic_id}" not in msg
    assert f"planctl close-preflight {_EID}" in msg


def test_bad_risk_rejects_before_brief(project):
    # `--risk` is a click.Choice, so an invalid value is rejected by click (exit 2)
    # before run() — assert click's usage error fires.
    r = CliRunner().invoke(
        cli, ["audit", "submit", _EID, "--file", "-", "--risk", "Severe"], input="x\n"
    )
    assert r.exit_code == 2
    assert "Severe" in r.output


def test_task_shaped_id_rejects_with_parent(project):
    r = CliRunner().invoke(
        cli,
        ["audit", "submit", "fn-7-demo-epic.2", "--file", "-", "--risk", "Low"],
        input="x\n",
    )
    assert r.exit_code == 1
    env = _envelope(r.output)
    assert env["error"]["code"] == "BAD_EPIC_ID"
    assert env["error"]["details"]["parent_epic"] == "fn-7-demo-epic"


def test_oversize_stdin_rejects(project):
    _seed_brief(project, _EID)
    big = "x" * (1 * 1024 * 1024 + 1)
    r = CliRunner().invoke(
        cli, ["audit", "submit", _EID, "--file", "-", "--risk", "Low"], input=big
    )
    assert r.exit_code == 1
    assert _envelope(r.output)["error"]["code"] == "PAYLOAD_TOO_LARGE"
