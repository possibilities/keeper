"""Tests for the read-only `planctl refine-context <epic_id>` verb.

The verb wraps the /plan:plan Phase R2 fetch behind one envelope:
``{epic_id, title, branch, last_validated_at, epic_spec_md,
tasks:[{id,title,status,deps,snippets,bundles,spec_md}]}``. It is a pure
spec-markdown + JSON read — no shell-outs — so these tests need no monkeypatch.

Coverage (per the task's Test notes):
- multi-task epic returns all per-task specs (epic route)
- single-task epic
- the task-route variant: stripping `.M` yields the same envelope (parent
  epic spec present, captured task in `tasks`)
- empty epic → tasks: []
- bad / missing epic id → typed error
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from click.testing import CliRunner
from planctl import run_refine_context
from planctl.cli import cli

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _task_spec(marker: str) -> str:
    """A four-section task spec carrying a unique marker in its Description."""
    return (
        f"## Description\n{marker}\n\n## Acceptance\n- [ ] x\n\n"
        "## Done summary\n\n## Evidence\n"
    )


def _make_epic(project, *, n_tasks):
    """Scaffold an epic + N tasks via the CLI, returning ``(epic_id, task_ids)``.

    Each task's Description carries a ``marker-<i>`` so per-task spec_md is
    distinguishable in assertions. ``n_tasks == 0`` scaffolds a one-task epic
    then is not used — empty-epic coverage uses the dedicated helper below.
    """
    runner = CliRunner()
    tasks_yaml = "\n".join(
        f"  - title: task {i}\n    tier: medium\n    spec: |\n"
        + "\n".join("      " + ln for ln in _task_spec(f"marker-{i}").splitlines())
        for i in range(1, n_tasks + 1)
    )
    yaml = (
        "epic:\n  title: Demo epic\n  branch: demo-branch\n  spec: |\n"
        "    ## Overview\n    demo overview\ntasks:\n" + tasks_yaml + "\n"
    )
    plan_path = project / "plan.yaml"
    plan_path.write_text(yaml, encoding="utf-8")

    r = runner.invoke(cli, ["scaffold", "--file", str(plan_path)])
    assert r.exit_code == 0, r.output
    env = _envelope(r.output)
    return env["epic_id"], env["task_ids"]


def _envelope(output: str) -> dict:
    """Parse the primary envelope, skipping a pure read-only invocation line.

    Mutating verbs (scaffold) emit one object carrying both payload keys AND
    `planctl_invocation`; read-only verbs (refine-context success) emit the
    payload first, then a separate trailing `{planctl_invocation: ...}` line.
    Return the first object carrying a payload key.
    """
    payload_keys = ("success", "error", "epic_id", "epic_spec_md")
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


# ---------------------------------------------------------------------------
# Epic route: per-task specs
# ---------------------------------------------------------------------------


class TestEpicRoute:
    def test_multi_task_returns_all_specs(self, project):
        epic_id, task_ids = _make_epic(project, n_tasks=3)
        r = CliRunner().invoke(cli, ["refine-context", epic_id])
        assert r.exit_code == 0, r.output
        env = _envelope(r.output)

        assert env["epic_id"] == epic_id
        assert env["title"] == "Demo epic"
        assert env["branch"] == "demo-branch"
        # scaffold stamps last_validated_at on the fresh epic
        # (in-memory integrity check passed → microsecond ISO timestamp).
        assert env["last_validated_at"] is not None
        assert env["last_validated_at"].endswith("Z")
        assert "." in env["last_validated_at"]
        assert "## Overview" in env["epic_spec_md"]
        assert "demo overview" in env["epic_spec_md"]

        # Ordered by ordinal, every per-task spec present + distinguishable.
        assert [t["id"] for t in env["tasks"]] == task_ids
        for i, t in enumerate(env["tasks"], start=1):
            assert t["status"] == "todo"
            assert t["deps"] == []
            assert t["snippets"] == []
            assert t["bundles"] == []
            assert f"marker-{i}" in t["spec_md"]

    def test_single_task_epic(self, project):
        epic_id, task_ids = _make_epic(project, n_tasks=1)
        r = CliRunner().invoke(cli, ["refine-context", epic_id])
        assert r.exit_code == 0, r.output
        env = _envelope(r.output)
        assert len(env["tasks"]) == 1
        assert env["tasks"][0]["id"] == task_ids[0]
        assert "marker-1" in env["tasks"][0]["spec_md"]


# ---------------------------------------------------------------------------
# Task route: strip `.M`, reuse the same envelope (parent spec present)
# ---------------------------------------------------------------------------


class TestTaskRoute:
    def test_task_route_includes_parent_epic_spec(self, project):
        epic_id, task_ids = _make_epic(project, n_tasks=2)
        # Task route: caller strips `.M` to get the epic id, fires the verb.
        derived_epic_id = task_ids[0].rsplit(".", 1)[0]
        assert derived_epic_id == epic_id

        r = CliRunner().invoke(cli, ["refine-context", derived_epic_id])
        assert r.exit_code == 0, r.output
        env = _envelope(r.output)
        # Parent epic spec is carried; the captured task sits in `tasks`.
        assert "## Overview" in env["epic_spec_md"]
        assert task_ids[0] in [t["id"] for t in env["tasks"]]


# ---------------------------------------------------------------------------
# Empty epic
# ---------------------------------------------------------------------------


def test_empty_epic_yields_empty_tasks(project):
    """An epic with zero tasks returns tasks: [] cleanly."""
    from planctl.cli import cli as _cli

    runner = CliRunner()
    # Create an epic directly (no tasks) — scaffold requires >=1 task, so use
    # the incremental epic-create verb.
    r = runner.invoke(_cli, ["epic", "create", "--title", "Bare epic"])
    assert r.exit_code == 0, r.output
    epic_id = _envelope_loose(r.output)
    r = runner.invoke(_cli, ["refine-context", epic_id])
    assert r.exit_code == 0, r.output
    env = _envelope(r.output)
    assert env["tasks"] == []
    assert env["epic_id"] == epic_id


def _envelope_loose(output: str) -> str:
    """Pull the epic_id out of an `epic create` envelope."""
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
        if "epic_id" in obj:
            return obj["epic_id"]
        if "epic" in obj and isinstance(obj["epic"], dict) and "id" in obj["epic"]:
            return obj["epic"]["id"]
        idx = end
    raise AssertionError(f"no epic_id in {output!r}")


# ---------------------------------------------------------------------------
# id / existence gates
# ---------------------------------------------------------------------------


class TestGates:
    def test_bad_epic_id(self, project):
        r = CliRunner().invoke(cli, ["refine-context", "not-an-id"])
        assert r.exit_code == 1, r.output
        env = _envelope(r.output)
        assert env["error"]["code"] == "BAD_EPIC_ID"

    def test_epic_not_found(self, project):
        r = CliRunner().invoke(cli, ["refine-context", "fn-99-missing"])
        assert r.exit_code == 1, r.output
        env = _envelope(r.output)
        assert env["error"]["code"] == "EPIC_NOT_FOUND"


def test_run_directly_no_click_context(project):
    """run() tolerates being called without a live click context (sentinel no-op)."""
    epic_id, _ = _make_epic(project, n_tasks=1)
    rc = run_refine_context.run(SimpleNamespace(epic_id=epic_id))
    assert rc == 0


# ---------------------------------------------------------------------------
# --invalidate (conditionally-mutating)
# ---------------------------------------------------------------------------


@pytest.mark.real_git
class TestInvalidate:
    def test_invalidate_clears_marker_one_envelope_one_commit(self, project):
        """--invalidate clears last_validated_at and lands ONE commit."""
        import subprocess

        epic_id, _ = _make_epic(project, n_tasks=1)

        # Sanity: scaffold stamped last_validated_at on mint, so a fresh epic
        # carries a non-null stamp.
        epic_path = project / ".planctl" / "epics" / f"{epic_id}.json"
        before = json.loads(epic_path.read_text(encoding="utf-8"))
        assert before["last_validated_at"] is not None

        head_before = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=project,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()

        r = CliRunner().invoke(cli, ["refine-context", epic_id, "--invalidate"])
        assert r.exit_code == 0, r.output
        env = _envelope(r.output)
        assert env["success"] is True
        assert env["last_validated_at"] is None
        assert env["invalidated"] is True

        # Disk reflects the clear.
        after = json.loads(epic_path.read_text(encoding="utf-8"))
        assert after["last_validated_at"] is None

        # Exactly one new commit landed (mutating refine-context path).
        head_after = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=project,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        assert head_before != head_after
        subj = subprocess.run(
            ["git", "log", "-1", "--pretty=%s"],
            cwd=project,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        assert "refine-context" in subj
        assert epic_id in subj

    def test_invalidate_short_circuits_when_already_null(self, project):
        """Marker already null → no write, no source-tree commit, but an envelope
        is still emitted via the readonly invocation builder.
        """
        import subprocess

        epic_id, _ = _make_epic(project, n_tasks=1)

        # First invalidation clears the marker.
        r1 = CliRunner().invoke(cli, ["refine-context", epic_id, "--invalidate"])
        assert r1.exit_code == 0, r1.output
        head_after_first = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=project,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()

        # Second invalidation: short-circuit — no write, no commit.
        r2 = CliRunner().invoke(cli, ["refine-context", epic_id, "--invalidate"])
        assert r2.exit_code == 0, r2.output
        env = _envelope(r2.output)
        assert env["last_validated_at"] is None
        assert env.get("invalidated") is False

        head_after_second = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=project,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        assert head_after_first == head_after_second

    def test_no_flag_is_read_only(self, project):
        """Without --invalidate, behavior is read-only and unchanged."""
        epic_id, _ = _make_epic(project, n_tasks=1)
        epic_path = project / ".planctl" / "epics" / f"{epic_id}.json"
        before = json.loads(epic_path.read_text(encoding="utf-8"))

        r = CliRunner().invoke(cli, ["refine-context", epic_id])
        assert r.exit_code == 0, r.output
        env = _envelope(r.output)
        assert env["last_validated_at"] == before["last_validated_at"]
        # No `invalidated` key on the read-only path.
        assert "invalidated" not in env

        after = json.loads(epic_path.read_text(encoding="utf-8"))
        assert after == before
