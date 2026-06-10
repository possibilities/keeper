"""Tests for `planctl verdict submit <epic_id>`.

The verdict-submit verb validates the close-planner's verdict JSON at emission —
structural (`VERDICT_SCHEMA`, additionalProperties:false on every node) THEN the
cross-field invariants jsonschema cannot express — and on success persists it
commit-free under `audits/<epic_id>/verdict.json` stamped with the brief's
`commit_set_hash` + `schema_version`. A reject returns the typed, minimal
envelope (top-3 errors + the schema fragment for the first failing path only).

Coverage (per the task's Test notes):
- happy path persists + envelope shape (hash stamped, expected_clusters)
- schema reject (bad JSON, extra key, wrong type) → VERDICT_INVALID, minimal
- each cross-field invariant: dangling merge, culled-with-task, kept-without-task,
  fatal-without-reason
- reject envelope is machine-readable (loc/type/msg) + a minimal schema fragment
- missing brief, oversize stdin
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from click.testing import CliRunner
from planctl.audit_artifacts import brief_path, compute_commit_set_hash, write_artifact
from planctl.cli import cli
from planctl.verdict_schema import (
    VERDICT_SCHEMA,
    cross_field_errors,
    schema_errors,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_EID = "fn-7-demo-epic"


def _envelope(output: str) -> dict:
    payload_keys = ("success", "error", "verdict_ref")
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


def _seed_brief(project: Path, *, commit_set_hash: str | None = None):
    if commit_set_hash is None:
        commit_set_hash = compute_commit_set_hash(
            [{"repo": str(project), "shas": ["abc123"]}]
        )
    brief = {
        "schema_version": 1,
        "epic_id": _EID,
        "primary_repo": str(project),
        "commit_set_hash": commit_set_hash,
        "commit_groups": [],
        "snippet_context": "",
        "tasks": [],
    }
    write_artifact(brief_path(project, _EID), json.dumps(brief) + "\n")
    return commit_set_hash


def _submit(project, verdict: dict | str):
    payload = verdict if isinstance(verdict, str) else json.dumps(verdict)
    return CliRunner().invoke(
        cli, ["verdict", "submit", _EID, "--file", "-"], input=payload
    )


# ---------------------------------------------------------------------------
# Schema self-check + unit coverage of the schema module
# ---------------------------------------------------------------------------


def test_schema_is_valid_json_schema():
    from jsonschema import Draft202012Validator

    Draft202012Validator.check_schema(VERDICT_SCHEMA)


def test_schema_errors_flags_extra_key():
    rows = schema_errors(
        {"fatal": False, "fatal_reason": "", "decisions": [], "junk": 1}
    )
    assert any(r["type"] == "additionalProperties" for r in rows)


def test_cross_field_dangling_merge():
    rows = cross_field_errors(
        {
            "fatal": False,
            "fatal_reason": "",
            "decisions": [
                {
                    "fid": "f1",
                    "action": "merged-into-ghost",
                    "task": 1,
                    "rationale": "r",
                }
            ],
        }
    )
    assert any(r["type"] == "dangling_merge_target" for r in rows)


def test_cross_field_clean_verdict_has_no_errors():
    assert (
        cross_field_errors(
            {
                "fatal": False,
                "fatal_reason": "",
                "decisions": [
                    {"fid": "a", "action": "kept", "task": 1, "rationale": "r"},
                    {
                        "fid": "b",
                        "action": "merged-into-a",
                        "task": 1,
                        "rationale": "r",
                    },
                    {"fid": "c", "action": "culled", "task": None, "rationale": "r"},
                ],
            }
        )
        == []
    )


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_happy_path_persists_and_stamps_hash(project):
    h = _seed_brief(project)
    r = _submit(
        project,
        {
            "fatal": False,
            "fatal_reason": "",
            "decisions": [
                {"fid": "f1", "action": "kept", "task": 1, "rationale": "ship"},
                {
                    "fid": "f2",
                    "action": "merged-into-f1",
                    "task": 1,
                    "rationale": "dup",
                },
                {"fid": "f3", "action": "culled", "task": None, "rationale": "noise"},
            ],
        },
    )
    assert r.exit_code == 0, r.output
    env = _envelope(r.output)
    assert env["commit_set_hash"] == h
    assert env["fatal"] is False
    assert env["decision_count"] == 3
    # f1 and f2 both land in ordinal 1 → one distinct cluster.
    assert env["expected_clusters"] == [1]

    record = json.loads(Path(env["verdict_ref"]).read_text())
    assert record["schema_version"] == 1
    assert record["commit_set_hash"] == h
    assert len(record["decisions"]) == 3


# ---------------------------------------------------------------------------
# Reject: schema
# ---------------------------------------------------------------------------


def test_bad_json_rejects(project):
    _seed_brief(project)
    r = _submit(project, "{not json")
    assert r.exit_code == 1
    assert _envelope(r.output)["error"]["code"] == "BAD_JSON"


def test_extra_key_rejects_minimal(project):
    _seed_brief(project)
    r = _submit(
        project, {"fatal": False, "fatal_reason": "", "decisions": [], "junk": 1}
    )
    assert r.exit_code == 1
    env = _envelope(r.output)
    assert env["error"]["code"] == "VERDICT_INVALID"
    details = env["error"]["details"]
    # Machine-readable rows with loc/type/msg.
    assert all({"loc", "type", "msg"} <= set(row) for row in details["errors"])
    # At most three rows surfaced; the true count is reported separately.
    assert len(details["errors"]) <= 3
    assert details["error_count"] >= 1
    # A minimal schema fragment — NOT the whole schema (no nested decisions item).
    frag = details["schema_fragment"]
    assert "decisions" in frag.get("properties", frag)


def test_wrong_type_task_rejects(project):
    _seed_brief(project)
    r = _submit(
        project,
        {
            "fatal": False,
            "fatal_reason": "",
            "decisions": [
                {"fid": "f1", "action": "kept", "task": "1", "rationale": "r"}
            ],
        },
    )
    assert r.exit_code == 1
    assert _envelope(r.output)["error"]["code"] == "VERDICT_INVALID"


# ---------------------------------------------------------------------------
# Reject: each cross-field invariant
# ---------------------------------------------------------------------------


def test_dangling_merge_rejects(project):
    _seed_brief(project)
    r = _submit(
        project,
        {
            "fatal": False,
            "fatal_reason": "",
            "decisions": [
                {"fid": "f1", "action": "merged-into-nope", "task": 1, "rationale": "r"}
            ],
        },
    )
    assert r.exit_code == 1
    env = _envelope(r.output)
    assert env["error"]["code"] == "VERDICT_INVALID"
    assert any(
        row["type"] == "dangling_merge_target"
        for row in env["error"]["details"]["errors"]
    )


def test_culled_with_task_rejects(project):
    _seed_brief(project)
    r = _submit(
        project,
        {
            "fatal": False,
            "fatal_reason": "",
            "decisions": [
                {"fid": "f1", "action": "culled", "task": 2, "rationale": "r"}
            ],
        },
    )
    assert r.exit_code == 1
    env = _envelope(r.output)
    assert any(
        row["type"] == "culled_task_not_null"
        for row in env["error"]["details"]["errors"]
    )


def test_kept_without_task_rejects(project):
    _seed_brief(project)
    r = _submit(
        project,
        {
            "fatal": False,
            "fatal_reason": "",
            "decisions": [
                {"fid": "f1", "action": "kept", "task": None, "rationale": "r"}
            ],
        },
    )
    assert r.exit_code == 1
    env = _envelope(r.output)
    assert any(
        row["type"] == "task_ordinal_required"
        for row in env["error"]["details"]["errors"]
    )


def test_fatal_without_reason_rejects(project):
    _seed_brief(project)
    r = _submit(project, {"fatal": True, "fatal_reason": "  ", "decisions": []})
    assert r.exit_code == 1
    env = _envelope(r.output)
    assert any(
        row["type"] == "fatal_reason_required"
        for row in env["error"]["details"]["errors"]
    )


def test_fatal_with_reason_passes(project):
    _seed_brief(project)
    r = _submit(
        project, {"fatal": True, "fatal_reason": "ship blocker", "decisions": []}
    )
    assert r.exit_code == 0, r.output
    assert _envelope(r.output)["fatal"] is True


# ---------------------------------------------------------------------------
# Reject: brief / stdin
# ---------------------------------------------------------------------------


def test_missing_brief_rejects(project):
    r = _submit(project, {"fatal": False, "fatal_reason": "", "decisions": []})
    assert r.exit_code == 1
    assert _envelope(r.output)["error"]["code"] == "BRIEF_MISSING"


def test_oversize_stdin_rejects(project):
    _seed_brief(project)
    r = _submit(project, "x" * (1 * 1024 * 1024 + 1))
    assert r.exit_code == 1
    assert _envelope(r.output)["error"]["code"] == "PAYLOAD_TOO_LARGE"


@pytest.mark.real_git
def test_no_commit_fires(project):
    _seed_brief(project)
    head_before = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=project, capture_output=True, text=True
    ).stdout.strip()
    r = _submit(project, {"fatal": False, "fatal_reason": "", "decisions": []})
    assert r.exit_code == 0, r.output
    head_after = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=project, capture_output=True, text=True
    ).stdout.strip()
    assert head_after == head_before
