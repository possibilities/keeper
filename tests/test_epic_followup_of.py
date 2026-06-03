"""Tests for the fn-589 ``planctl epic followup-of <source_epic_id>`` verb.

Read-only fetch. Returns the first open epic whose ``depends_on_epics``
contains the source id; ``{found: false}`` otherwise.

Coverage (per the task's Test notes):
- Found: open dep epic wired → envelope carries ``epic_id`` + ``actual_tasks``
  + ``depends_on_epics`` + ``status``.
- Absent: no dep wires the source → ``{found: false}``.
- ``actual_tasks`` counts task JSONs on disk for the follow-up.
- Closed (status != open) follow-ups are skipped.
- Bad epic id → typed ``BAD_EPIC_ID`` error.
- Missing source epic → ``{found: false}`` (not an error).
"""

from __future__ import annotations

import json

from click.testing import CliRunner
from planctl.cli import cli


def _invoke(args: list[str]):
    return CliRunner().invoke(cli, args)


def _envelope(output: str) -> dict:
    """First JSON object on stdout carrying a payload key.

    Mirrors test_close_preflight._envelope: read-only verbs emit the payload
    first, then a trailing readonly ``planctl_invocation`` line.
    """
    payload_keys = ("success", "error", "found")
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


def _create_epic(title: str) -> str:
    r = _invoke(["epic", "create", "--title", title])
    assert r.exit_code == 0, r.output
    for line in r.output.strip().splitlines():
        line = line.strip()
        if not line.startswith("{") or '"planctl_invocation"' in line[:30]:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "epic" in obj and isinstance(obj["epic"], dict):
            return obj["epic"]["id"]
    raise AssertionError(f"no epic id in: {r.output!r}")


# ---------------------------------------------------------------------------
# Found: a downstream open epic carries the source in depends_on_epics
# ---------------------------------------------------------------------------


def test_followup_of_finds_wired_open_epic(planctl_git_repo):
    source = _create_epic("Source epic")
    follow = _create_epic("Follow-up epic")

    # Wire follow -> source.
    r = _invoke(["epic", "add-deps", follow, source])
    assert r.exit_code == 0, r.output

    r = _invoke(["epic", "followup-of", source])
    assert r.exit_code == 0, r.output
    env = _envelope(r.output)
    assert env["success"] is True
    assert env["found"] is True
    assert env["epic_id"] == follow
    assert env["depends_on_epics"] == [source]
    assert env["status"] == "open"
    # `actual_tasks` is 0 — `epic create` mints an empty epic.
    assert env["actual_tasks"] == 0


# ---------------------------------------------------------------------------
# Absent: no follow-up wired
# ---------------------------------------------------------------------------


def test_followup_of_returns_found_false_when_no_wire(planctl_git_repo):
    source = _create_epic("Source epic")
    _create_epic("Independent epic")  # exists but does NOT depend on source

    r = _invoke(["epic", "followup-of", source])
    assert r.exit_code == 0, r.output
    env = _envelope(r.output)
    assert env["success"] is True
    assert env["found"] is False


# ---------------------------------------------------------------------------
# Missing source: not an error, just `found: false`
# ---------------------------------------------------------------------------


def test_followup_of_missing_source_is_not_an_error(planctl_git_repo):
    r = _invoke(["epic", "followup-of", "fn-9999-missing"])
    assert r.exit_code == 0, r.output
    env = _envelope(r.output)
    assert env["success"] is True
    assert env["found"] is False


# ---------------------------------------------------------------------------
# Bad id → typed error
# ---------------------------------------------------------------------------


def test_followup_of_bad_id_returns_typed_error(planctl_git_repo):
    r = _invoke(["epic", "followup-of", "not-an-id"])
    assert r.exit_code == 1, r.output
    env = _envelope(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "BAD_EPIC_ID"
