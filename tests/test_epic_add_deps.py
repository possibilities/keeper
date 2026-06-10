"""Tests for the fn-565 `planctl epic add-deps` batch verb.

Coverage:
- Multi-edge wire: N edges land in one call, one planctl_invocation envelope.
- Duplicate edge → ALREADY_PRESENT (no-op, not an error).
- Self-reference / nonexistent target → per-edge error collected in details.
- Cycle introduction rejected.
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


def _count_planctl_invocation_lines(output: str) -> int:
    return sum(
        1
        for ln in output.strip().splitlines()
        if ln.strip().startswith("{") and "planctl_invocation" in ln
    )


def _create_epic(title: str) -> str:
    r = _invoke(["epic", "create", "--title", title])
    assert r.exit_code == 0, r.output
    return _parse_envelope(r.output)["epic"]["id"]


def _read_epic_json(project_path, epic_id) -> dict:
    p = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    return json.loads(p.read_text())


# ---------------------------------------------------------------------------
# Happy path: multi-edge wire
# ---------------------------------------------------------------------------


def test_add_deps_wires_multiple_edges_one_envelope(project):
    epic_id = _create_epic("Target epic")
    dep1 = _create_epic("Dep one")
    dep2 = _create_epic("Dep two")

    r = _invoke(["epic", "add-deps", epic_id, dep1, dep2])
    assert r.exit_code == 0, r.output

    payload = _parse_envelope(r.output)
    assert payload["success"] is True
    assert payload["epic_id"] == epic_id
    assert payload["depends_on_epics"] == [dep1, dep2]

    statuses = {r["dep_id"]: r["status"] for r in payload["results"]}
    assert statuses == {dep1: "WIRED", dep2: "WIRED"}

    # Exactly ONE planctl_invocation line (op=add-deps).
    assert _count_planctl_invocation_lines(r.output) == 1
    pc = payload["planctl_invocation"]
    assert pc["op"] == "add-deps"
    assert pc["target"] == epic_id
    assert pc["subject"] == f"chore(planctl): add-deps {epic_id}"

    # Persisted on disk.
    assert _read_epic_json(project, epic_id)["depends_on_epics"] == [
        dep1,
        dep2,
    ]


# ---------------------------------------------------------------------------
# Idempotency: dup edge → ALREADY_PRESENT (no-op, not an error)
# ---------------------------------------------------------------------------


def test_add_deps_dup_edge_is_already_present(project):
    epic_id = _create_epic("Target epic")
    dep1 = _create_epic("Dep one")

    # First wire.
    r1 = _invoke(["epic", "add-deps", epic_id, dep1])
    assert r1.exit_code == 0, r1.output

    # Re-wire the same edge — must be a no-op success, not an error.
    r2 = _invoke(["epic", "add-deps", epic_id, dep1])
    assert r2.exit_code == 0, r2.output
    payload = _parse_envelope(r2.output)
    assert payload["success"] is True
    statuses = {r["dep_id"]: r["status"] for r in payload["results"]}
    assert statuses == {dep1: "ALREADY_PRESENT"}
    # Dep list unchanged (no duplicate appended).
    assert payload["depends_on_epics"] == [dep1]


def test_add_deps_mixed_new_and_present(project):
    epic_id = _create_epic("Target epic")
    dep1 = _create_epic("Dep one")
    dep2 = _create_epic("Dep two")

    _invoke(["epic", "add-deps", epic_id, dep1])
    r = _invoke(["epic", "add-deps", epic_id, dep1, dep2])
    assert r.exit_code == 0, r.output
    payload = _parse_envelope(r.output)
    statuses = {r["dep_id"]: r["status"] for r in payload["results"]}
    assert statuses == {dep1: "ALREADY_PRESENT", dep2: "WIRED"}
    assert payload["depends_on_epics"] == [dep1, dep2]


# ---------------------------------------------------------------------------
# Per-edge error collection
# ---------------------------------------------------------------------------


def test_add_deps_self_reference_collected(project):
    epic_id = _create_epic("Target epic")

    r = _invoke(["epic", "add-deps", epic_id, epic_id])
    assert r.exit_code != 0, r.output
    payload = _parse_envelope(r.output)
    assert payload["success"] is False
    assert payload["error"]["code"] == "bad_id"
    assert any("itself" in d for d in payload["error"]["details"])

    # Nothing wired.
    assert _read_epic_json(project, epic_id)["depends_on_epics"] == []


def test_add_deps_nonexistent_target_collected(project):
    epic_id = _create_epic("Target epic")
    dep1 = _create_epic("Dep one")

    r = _invoke(["epic", "add-deps", epic_id, dep1, "fn-9999-does-not-exist"])
    assert r.exit_code != 0, r.output
    payload = _parse_envelope(r.output)
    assert payload["success"] is False
    assert payload["error"]["code"] == "epic_not_found"
    assert any("fn-9999-does-not-exist" in d for d in payload["error"]["details"])

    # Assert-all → no partial write: the valid dep1 edge must NOT have landed.
    assert _read_epic_json(project, epic_id)["depends_on_epics"] == []


# ---------------------------------------------------------------------------
# Cycle rejection
# ---------------------------------------------------------------------------


def test_add_deps_cycle_rejected(project):
    a = _create_epic("Epic A")
    b = _create_epic("Epic B")

    # A -> B is fine.
    r1 = _invoke(["epic", "add-deps", a, b])
    assert r1.exit_code == 0, r1.output

    # B -> A would close the cycle A -> B -> A.
    r2 = _invoke(["epic", "add-deps", b, a])
    assert r2.exit_code != 0, r2.output
    payload = _parse_envelope(r2.output)
    assert payload["success"] is False
    assert payload["error"]["code"] == "dep_cycle"

    # B's dep list must be untouched.
    assert _read_epic_json(project, b)["depends_on_epics"] == []


# ---------------------------------------------------------------------------
# fn-589 task .1 (item 9): --skip-invalid routes per-edge errors into results
# ---------------------------------------------------------------------------


def test_add_deps_skip_invalid_routes_bad_id_into_results(project):
    """--skip-invalid: a malformed id lands as SKIPPED_BAD_ID, exit stays 0."""
    epic_id = _create_epic("Target epic")
    dep1 = _create_epic("Dep one")

    r = _invoke(["epic", "add-deps", "--skip-invalid", epic_id, "not-an-id", dep1])
    assert r.exit_code == 0, r.output
    payload = _parse_envelope(r.output)
    assert payload["success"] is True
    statuses = {r["dep_id"]: r["status"] for r in payload["results"]}
    assert statuses == {"not-an-id": "SKIPPED_BAD_ID", dep1: "WIRED"}
    # Valid edge still landed.
    assert _read_epic_json(project, epic_id)["depends_on_epics"] == [dep1]


def test_add_deps_skip_invalid_routes_not_found_into_results(project):
    """--skip-invalid: a missing dep epic lands as SKIPPED_NOT_FOUND."""
    epic_id = _create_epic("Target epic")
    dep1 = _create_epic("Dep one")

    r = _invoke(
        ["epic", "add-deps", "--skip-invalid", epic_id, "fn-9999-missing", dep1]
    )
    assert r.exit_code == 0, r.output
    payload = _parse_envelope(r.output)
    statuses = {r["dep_id"]: r["status"] for r in payload["results"]}
    assert statuses == {"fn-9999-missing": "SKIPPED_NOT_FOUND", dep1: "WIRED"}


def test_add_deps_skip_invalid_all_skip_exits_zero(project):
    """--skip-invalid: every edge skips → success envelope, exit 0."""
    epic_id = _create_epic("Target epic")

    r = _invoke(
        ["epic", "add-deps", "--skip-invalid", epic_id, "fn-9999-missing", "not-an-id"]
    )
    assert r.exit_code == 0, r.output
    payload = _parse_envelope(r.output)
    assert payload["success"] is True
    statuses = {r["dep_id"]: r["status"] for r in payload["results"]}
    assert statuses == {
        "fn-9999-missing": "SKIPPED_NOT_FOUND",
        "not-an-id": "SKIPPED_BAD_ID",
    }
    # No edge wired.
    assert _read_epic_json(project, epic_id)["depends_on_epics"] == []


def test_add_deps_default_fail_loud_unchanged(project):
    """Without --skip-invalid, the existing fail-loud behavior is preserved."""
    epic_id = _create_epic("Target epic")
    dep1 = _create_epic("Dep one")

    r = _invoke(["epic", "add-deps", epic_id, "fn-9999-missing", dep1])
    assert r.exit_code != 0, r.output
    payload = _parse_envelope(r.output)
    assert payload["success"] is False
    assert payload["error"]["code"] == "epic_not_found"
    # No partial write.
    assert _read_epic_json(project, epic_id)["depends_on_epics"] == []


# ---------------------------------------------------------------------------
# fn-20: number-only `fn-N` dep input normalizes to the full slug on write
# ---------------------------------------------------------------------------


def test_add_deps_number_only_wires_and_persists_full_slug(project):
    """`add-deps <epic> fn-N` wires the unique number match; persists full slug."""
    from planctl.ids import parse_id

    epic_id = _create_epic("Target epic")
    dep_full = _create_epic("Dep one")
    dep_num, _ = parse_id(dep_full)
    number_only = f"fn-{dep_num}"
    assert number_only != dep_full  # the input really is the bare number

    r = _invoke(["epic", "add-deps", epic_id, number_only])
    assert r.exit_code == 0, r.output
    payload = _parse_envelope(r.output)
    assert payload["success"] is True

    # The persisted edge is the FULL slug id, never the bare number.
    assert payload["depends_on_epics"] == [dep_full]
    assert _read_epic_json(project, epic_id)["depends_on_epics"] == [dep_full]
    # The per-edge result reports the normalized id.
    statuses = {r["dep_id"]: r["status"] for r in payload["results"]}
    assert statuses == {dep_full: "WIRED"}


def test_add_deps_number_only_already_present_via_full_slug(project):
    """A bare-number re-wire of an already-wired slug edge is ALREADY_PRESENT."""
    from planctl.ids import parse_id

    epic_id = _create_epic("Target epic")
    dep_full = _create_epic("Dep one")
    dep_num, _ = parse_id(dep_full)

    # First wire via full slug.
    r1 = _invoke(["epic", "add-deps", epic_id, dep_full])
    assert r1.exit_code == 0, r1.output

    # Re-supply the same edge as a bare number — must dedup against full slug.
    r2 = _invoke(["epic", "add-deps", epic_id, f"fn-{dep_num}"])
    assert r2.exit_code == 0, r2.output
    payload = _parse_envelope(r2.output)
    statuses = {r["dep_id"]: r["status"] for r in payload["results"]}
    assert statuses == {dep_full: "ALREADY_PRESENT"}
    assert _read_epic_json(project, epic_id)["depends_on_epics"] == [dep_full]


def test_add_deps_number_only_prefix_trap_fn1_not_fn10(project):
    """`fn-1` must not match `fn-10` — integer equality, never string prefix."""
    from planctl.ids import parse_id

    # Mint epics until both a number-1 and a number-10 epic exist so the
    # prefix trap is real. epic create allocates sequential numbers; create
    # ten so fn-10 exists alongside fn-1.
    created: dict[int, str] = {}
    while not ({1, 10} <= created.keys()):
        full = _create_epic(f"Filler {len(created)}")
        n, _ = parse_id(full)
        assert n is not None
        created[n] = full

    epic_id = _create_epic("Target epic")

    # Wiring `fn-1` must resolve to the fn-1 epic, NOT the fn-10 epic.
    r = _invoke(["epic", "add-deps", epic_id, "fn-1"])
    assert r.exit_code == 0, r.output
    payload = _parse_envelope(r.output)
    assert payload["depends_on_epics"] == [created[1]]
    assert created[1] != created[10]
