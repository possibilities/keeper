"""Tests for the orphan-epic reaper (fn-629 task .4).

Coverage matrix (from the task spec):

- stale, unowned, untracked orphan epic tree → reaped
- fresh, in-flight, untracked tree owned by a live session → NOT reaped (the
  fn-627 hazard — this is the load-bearing regression test)
- tracked epic tree (in git HEAD) → never touched even when stale
- reaper error never blocks the actual scaffold (fail-soft contract)
- reaper runs at the start of refine-apply too (sibling pre-flight)

Threshold strategy: instead of faking wall-clock time (fragile and
introduces timezone weirdness), tests monkey-patch the module-level
``_REAP_MIN_AGE_SECONDS`` / ``_LIVE_SESSION_WINDOW_SECONDS`` constants to
zero so a freshly-mtimed file qualifies, then bump mtimes back via
``os.utime`` for the cases that need a real-time baseline.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

import pytest
from click.testing import CliRunner
from planctl import reaper
from planctl.cli import cli

from .conftest import _scaffold_plan_yaml, parse_cli_output, seed_epic


@pytest.fixture
def reaper_zero_age(monkeypatch):
    """Patch the reaper's gate thresholds to 0 so anything qualifies.

    Tests that need to assert the gate-passes path use this fixture and
    then mtime-bump files as needed. Tests that need the live-session veto
    use this same fixture and write a session touched-record file so the
    veto fires.
    """
    monkeypatch.setattr(reaper, "_REAP_MIN_AGE_SECONDS", 0)
    monkeypatch.setattr(reaper, "_LIVE_SESSION_WINDOW_SECONDS", 0)


def _make_untracked_epic_tree(
    repo: Path, epic_id: str, *, with_tasks: int = 1
) -> list[Path]:
    """Hand-write an epic tree directly to disk WITHOUT committing it.

    Mirrors the on-disk shape ``scaffold`` would have written if a hard
    ``commit_failed`` had landed (§10 no-rollback): files exist at their
    final paths but are git-untracked. Returns the list of written paths
    so tests can assert presence / absence.
    """
    data_dir = repo / ".planctl"
    epic_path = data_dir / "epics" / f"{epic_id}.json"
    epic_spec_path = data_dir / "specs" / f"{epic_id}.md"
    epic_path.parent.mkdir(parents=True, exist_ok=True)
    epic_spec_path.parent.mkdir(parents=True, exist_ok=True)

    epic_doc = {
        "id": epic_id,
        "title": "orphan epic",
        "status": "open",
        "branch_name": epic_id,
        "depends_on_epics": [],
        "plan_review_status": "unknown",
        "plan_reviewed_at": None,
        "primary_repo": str(repo),
        "touched_repos": [str(repo)],
        "snippets": [],
        "bundles": [],
        "queue_jump": False,
        "last_validated_at": None,
        "created_at": "2026-01-01T00:00:00.000000Z",
        "updated_at": "2026-01-01T00:00:00.000000Z",
    }
    epic_path.write_text(json.dumps(epic_doc, indent=2, sort_keys=True) + "\n")
    epic_spec_path.write_text("## Overview\norphan\n")
    written = [epic_path, epic_spec_path]

    tasks_dir = data_dir / "tasks"
    specs_dir = data_dir / "specs"
    tasks_dir.mkdir(parents=True, exist_ok=True)
    for i in range(1, with_tasks + 1):
        task_id = f"{epic_id}.{i}"
        tp = tasks_dir / f"{task_id}.json"
        sp = specs_dir / f"{task_id}.md"
        task_doc = {
            "id": task_id,
            "epic": epic_id,
            "title": f"orphan task {i}",
            "priority": None,
            "depends_on": [],
            "target_repo": str(repo),
            "tier": "medium",
            "snippets": [],
            "bundles": [],
            "created_at": "2026-01-01T00:00:00.000000Z",
            "updated_at": "2026-01-01T00:00:00.000000Z",
        }
        tp.write_text(json.dumps(task_doc, indent=2, sort_keys=True) + "\n")
        sp.write_text(
            "## Description\norphan\n\n## Acceptance\n- [ ] x\n\n"
            "## Done summary\n\n## Evidence\n"
        )
        written.extend([tp, sp])

    return written


def _backdate(paths: list[Path], *, seconds_ago: int) -> None:
    """Set the mtime of every path to ``now - seconds_ago``.

    Lets us simulate a stale orphan without sleeping or freezing the clock.
    """
    target = time.time() - seconds_ago
    for p in paths:
        if p.exists():
            os.utime(p, (target, target))


def _git_tracked(repo: Path, rel: str) -> bool:
    """Return True if *rel* (repo-relative) is tracked in git."""
    result = subprocess.run(
        ["git", "ls-files", "--error-unmatch", "--", rel],
        cwd=repo,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


# ---------------------------------------------------------------------------
# Core reaper unit tests — invoke reap_orphan_epics() directly.
# ---------------------------------------------------------------------------


def test_reaper_sweeps_stale_unowned_untracked_orphan(
    planctl_git_repo, reaper_zero_age
):
    """A stale, unowned, untracked epic tree is reaped (the happy path)."""
    written = _make_untracked_epic_tree(planctl_git_repo, "fn-99-orphan", with_tasks=2)
    # Sanity: every file is on disk, none is tracked.
    for p in written:
        assert p.exists()
    assert not _git_tracked(planctl_git_repo, ".planctl/epics/fn-99-orphan.json")

    reaped = reaper.reap_orphan_epics(planctl_git_repo / ".planctl", planctl_git_repo)

    assert reaped == ["fn-99-orphan"]
    # Every written path is gone.
    for p in written:
        assert not p.exists(), f"{p} survived reap"


def test_reaper_skips_fresh_untracked_tree_in_flight(planctl_git_repo, monkeypatch):
    """A fresh untracked tree owned by a live session is NOT reaped.

    This is the regression for the fn-627 hazard: reaping a concurrent
    session's in-flight pre-commit tree would re-create the orphan-
    dispatch bug in reverse. The 5-minute mtime floor + the live-session
    veto must BOTH block the reap.
    """
    # Real production thresholds — 5 min mtime floor, 10 min live window.
    # Default values are already what the reaper uses; assert by not patching.
    monkeypatch.setattr(reaper, "_REAP_MIN_AGE_SECONDS", 5 * 60)
    monkeypatch.setattr(reaper, "_LIVE_SESSION_WINDOW_SECONDS", 10 * 60)

    written = _make_untracked_epic_tree(
        planctl_git_repo, "fn-99-inflight", with_tasks=1
    )

    # Simulate a live session: write a touched-record file with current mtime.
    sessions = (
        planctl_git_repo
        / ".planctl"
        / "state"
        / "sessions"
        / "live-session"
        / "touched"
    )
    sessions.mkdir(parents=True, exist_ok=True)
    (sessions / "fresh.txt").write_text(".planctl/epics/fn-99-inflight.json\n")

    reaped = reaper.reap_orphan_epics(planctl_git_repo / ".planctl", planctl_git_repo)

    assert reaped == []
    # Every file survives.
    for p in written:
        assert p.exists(), f"{p} was reaped but is in-flight"


def test_reaper_skips_fresh_orphan_when_only_age_gate_fails(
    planctl_git_repo, monkeypatch
):
    """A fresh untracked tree with NO live session is still not reaped.

    Belt-and-suspenders: the age gate alone must protect a tree freshly
    written by a session that has since exited but whose touched-records
    might have been GC'd. We never reap until BOTH gates pass — the
    age gate is the primary protector.
    """
    monkeypatch.setattr(reaper, "_REAP_MIN_AGE_SECONDS", 5 * 60)
    monkeypatch.setattr(reaper, "_LIVE_SESSION_WINDOW_SECONDS", 0)  # no veto

    written = _make_untracked_epic_tree(planctl_git_repo, "fn-99-fresh", with_tasks=1)
    # mtime is now (recent) — well under the 5-minute floor.

    reaped = reaper.reap_orphan_epics(planctl_git_repo / ".planctl", planctl_git_repo)

    assert reaped == []
    for p in written:
        assert p.exists()


def test_reaper_skips_tracked_epic_tree(planctl_git_repo, monkeypatch):
    """A tracked epic tree (committed to git) is NEVER reaped.

    Even with both gate thresholds zeroed and the tree at stale-age, the
    tracked-check short-circuits the reap. Tracked state is authoritative.
    """
    monkeypatch.setattr(reaper, "_REAP_MIN_AGE_SECONDS", 0)
    monkeypatch.setattr(reaper, "_LIVE_SESSION_WINDOW_SECONDS", 0)

    # Scaffold a real epic — this commits it to git.
    epic_id, task_ids = seed_epic(planctl_git_repo, title="tracked epic", n_tasks=1)

    epic_path = planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json"
    assert _git_tracked(planctl_git_repo, f".planctl/epics/{epic_id}.json")

    # Backdate the mtime to satisfy the stale predicate too.
    _backdate([epic_path], seconds_ago=10_000)

    reaped = reaper.reap_orphan_epics(planctl_git_repo / ".planctl", planctl_git_repo)

    assert reaped == []
    assert epic_path.exists()


def test_reaper_is_idempotent(planctl_git_repo, reaper_zero_age):
    """Calling the reaper twice on a sweep target is a no-op the second time.

    First call reaps; second call finds no untracked epic JSONs and
    returns an empty list without raising.
    """
    _make_untracked_epic_tree(planctl_git_repo, "fn-99-idem", with_tasks=1)

    first = reaper.reap_orphan_epics(planctl_git_repo / ".planctl", planctl_git_repo)
    second = reaper.reap_orphan_epics(planctl_git_repo / ".planctl", planctl_git_repo)

    assert first == ["fn-99-idem"]
    assert second == []


def test_reaper_is_fail_soft_on_git_failure(
    planctl_git_repo, reaper_zero_age, monkeypatch
):
    """A subprocess failure inside the tracked-check skips the reap; never raises.

    Patches ``subprocess.run`` to raise inside the reaper module — every
    error path returns an empty list (no orphans were reaped because we
    could not safely classify them).
    """
    _make_untracked_epic_tree(planctl_git_repo, "fn-99-bad-git", with_tasks=1)

    def _boom(*_a, **_kw):
        raise RuntimeError("synthetic git failure")

    monkeypatch.setattr(reaper.subprocess, "run", _boom)

    # The reaper MUST NOT raise.
    reaped = reaper.reap_orphan_epics(planctl_git_repo / ".planctl", planctl_git_repo)
    assert reaped == []


# ---------------------------------------------------------------------------
# Integration: reaper runs as a pre-flight inside scaffold + refine-apply.
# ---------------------------------------------------------------------------


def _two_task_yaml() -> str:
    return _scaffold_plan_yaml(title="next mint", n_tasks=2)


def test_scaffold_preflight_reaps_orphan(planctl_git_repo, monkeypatch):
    """A scaffold invocation sweeps a pre-existing stale unowned orphan.

    The orphan is a tree written hand to disk (no live session) and aged
    past the 5-minute floor (via mtime backdating). scaffold's Phase-3
    pre-flight reaps it, then proceeds normally; the success envelope
    confirms the actual mutation went through.
    """
    monkeypatch.setattr(reaper, "_REAP_MIN_AGE_SECONDS", 0)
    monkeypatch.setattr(reaper, "_LIVE_SESSION_WINDOW_SECONDS", 0)

    orphan_paths = _make_untracked_epic_tree(
        planctl_git_repo, "fn-77-orphan", with_tasks=1
    )

    yaml_path = planctl_git_repo / "_plan.yaml"
    yaml_path.write_text(_two_task_yaml())

    runner = CliRunner()
    r = runner.invoke(cli, ["scaffold", "--file", str(yaml_path)])
    assert r.exit_code == 0, r.output

    # Orphan is gone.
    for p in orphan_paths:
        assert not p.exists(), f"{p} survived scaffold's pre-flight reap"

    # The actual scaffold succeeded: payload carries a fresh epic id.
    payload = parse_cli_output(r.output)
    assert payload["epic_id"] != "fn-77-orphan"
    assert payload["epic_id"].startswith("fn-")


def test_refine_apply_preflight_reaps_orphan(planctl_git_repo, monkeypatch):
    """refine-apply also sweeps the orphan as a Phase-3 pre-flight.

    Sibling-verb coverage: every mutating verb that goes through the seam
    should benefit from the reaper. We pick refine-apply because it's the
    other heavyweight write path (the rest are single-field mutations).
    """
    monkeypatch.setattr(reaper, "_REAP_MIN_AGE_SECONDS", 0)
    monkeypatch.setattr(reaper, "_LIVE_SESSION_WINDOW_SECONDS", 0)

    # Seed a real epic to refine against.
    epic_id, _ = seed_epic(planctl_git_repo, title="refine target", n_tasks=1)

    # Plant an orphan that the refine-apply pre-flight should sweep.
    orphan_paths = _make_untracked_epic_tree(
        planctl_git_repo, "fn-66-orphan", with_tasks=1
    )

    # Build a minimal delta — rewrite the existing task's spec.
    spec = (
        "## Description\nrefined\n\n## Acceptance\n- [ ] y\n\n"
        "## Done summary\n\n## Evidence\n"
    )
    spec_indented = "\n".join("      " + ln for ln in spec.splitlines())
    delta_path = planctl_git_repo / "_delta.yaml"
    delta_path.write_text(
        f"rewrite_specs:\n  - task_id: {epic_id}.1\n    spec: |\n{spec_indented}\n"
    )

    runner = CliRunner()
    r = runner.invoke(cli, ["refine-apply", epic_id, "--file", str(delta_path)])
    assert r.exit_code == 0, r.output

    # Orphan is gone; the seeded epic survived.
    for p in orphan_paths:
        assert not p.exists(), f"{p} survived refine-apply's pre-flight reap"
    assert (planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json").exists()


def test_scaffold_preflight_skips_live_orphan(planctl_git_repo, monkeypatch):
    """scaffold pre-flight does NOT reap a fresh in-flight pre-commit tree.

    This is the critical regression: a concurrent session is racing
    toward its own commit, has written its tree, and our scaffold fires
    its pre-flight. The live-session veto + the fresh-mtime gate must
    BOTH protect the in-flight tree. We use production thresholds
    (5min / 10min) and plant a fresh touched-record so the live check
    fires.
    """
    monkeypatch.setattr(reaper, "_REAP_MIN_AGE_SECONDS", 5 * 60)
    monkeypatch.setattr(reaper, "_LIVE_SESSION_WINDOW_SECONDS", 10 * 60)

    inflight_paths = _make_untracked_epic_tree(
        planctl_git_repo, "fn-55-inflight", with_tasks=1
    )

    # Concurrent live session's touched-record (fresh mtime).
    sessions = (
        planctl_git_repo
        / ".planctl"
        / "state"
        / "sessions"
        / "concurrent-session"
        / "touched"
    )
    sessions.mkdir(parents=True, exist_ok=True)
    (sessions / "recent.txt").write_text(".planctl/epics/fn-55-inflight.json\n")

    yaml_path = planctl_git_repo / "_plan.yaml"
    yaml_path.write_text(_two_task_yaml())

    runner = CliRunner()
    r = runner.invoke(cli, ["scaffold", "--file", str(yaml_path)])
    assert r.exit_code == 0, r.output

    # The in-flight tree survives intact.
    for p in inflight_paths:
        assert p.exists(), f"{p} was reaped — this is the fn-627 hazard regressing"
