"""Tests for the singular `planctl epic add-dep` verb.

Coverage:
- Cycle introduction via the post-write integrity gate is rejected and the
  dep write is rolled back on disk (fn-590 task .1 fix + .2 regression).
"""

from __future__ import annotations

import json

from click.testing import CliRunner
from planctl.cli import cli


def _invoke(args: list[str]):
    runner = CliRunner()
    return runner.invoke(cli, args)


def _parse_envelope(output: str) -> dict:
    """First JSON document on stdout (skip stderr noise / non-JSON lines)."""
    for ln in output.strip().splitlines():
        stripped = ln.strip()
        if stripped.startswith("{"):
            return json.loads(stripped)
    raise AssertionError(f"No JSON line found in output: {output!r}")


def _create_epic(title: str) -> str:
    r = _invoke(["epic", "create", "--title", title])
    assert r.exit_code == 0, r.output
    return _parse_envelope(r.output)["epic"]["id"]


def _read_epic_json(project_path, epic_id) -> dict:
    p = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    return json.loads(p.read_text())


# ---------------------------------------------------------------------------
# fn-590 task .2: post-write cycle gate rejects + rolls back the dep write
# ---------------------------------------------------------------------------


def test_add_dep_cycle_rejected_and_rolled_back(planctl_git_repo):
    """A -> B -> A via singular add-dep: rejected by the post-write integrity
    gate; the rejected dep must be rolled back so B's depends_on_epics stays
    empty on disk."""
    a = _create_epic("Epic A")
    b = _create_epic("Epic B")

    # A -> B is fine (no cycle yet).
    r1 = _invoke(["epic", "add-dep", a, b])
    assert r1.exit_code == 0, r1.output

    # B -> A would close the cycle A -> B -> A — must be rejected by the
    # post-write integrity gate (singular add-dep has no pre-write check).
    r2 = _invoke(["epic", "add-dep", b, a])
    assert r2.exit_code != 0, r2.output

    payload = _parse_envelope(r2.output)
    assert payload["success"] is False
    err = payload["error"]
    # The restamp helper emits `integrity_failed` (general gate); the cycle
    # specifics live in the details string.
    assert err["code"] == "integrity_failed" or any(
        "epic-dep cycle detected" in d for d in err.get("details", [])
    )

    # fn-590 task .1 rollback: B's dep list must be untouched on disk after
    # the rejected write.
    assert _read_epic_json(planctl_git_repo, b)["depends_on_epics"] == []
