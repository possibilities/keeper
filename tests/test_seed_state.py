"""Fidelity self-test for the ``seed_state`` conftest helper.

``seed_state`` builds a ``.planctl/`` tree by routing hand-built epic/task
dicts through ``normalize_epic`` / ``normalize_task`` + ``atomic_write_json``
— the SAME serialization seams the read path runs. This test reads the tree
back through the canonical read path (``normalize_*(load_json(...))``) and
asserts the loaded records equal what ``normalize_*`` produces, so any future
schema change that would drift a seeded tree from the read path breaks here
first.
"""

from __future__ import annotations

from pathlib import Path

from .conftest import seed_state
from planctl.models import (
    SCHEMA_VERSION,
    normalize_epic,
    normalize_task,
)
from planctl.store import load_json


def test_seed_state_builds_skeleton(tmp_path):
    """The skeleton + meta.json + inner gitignore match the init contract."""
    seed_state(tmp_path, epic_id="fn-1-seed")

    planctl_dir = tmp_path / ".planctl"
    for subdir in ("epics", "specs", "tasks", "state"):
        assert (planctl_dir / subdir).is_dir()
    assert load_json(planctl_dir / "meta.json") == {"schema_version": SCHEMA_VERSION}
    assert (planctl_dir / ".gitignore").read_text(encoding="utf-8") == "state/\n"


def test_seed_state_round_trip_zero_drift(tmp_path):
    """Loaded epic + tasks equal what the real normalize path produces.

    This is the living fidelity contract: ``seed_state`` writes through
    ``normalize_*``, and the read path re-runs ``normalize_*`` over the loaded
    JSON. Equality proves the helper introduces no schema drift.
    """
    epic_id, task_ids = seed_state(
        tmp_path,
        epic_id="fn-2-seed",
        n_tasks=2,
        epic_snippets=["snippet/a"],
        task_snippets={1: ["snippet/b"]},
        task_deps={2: [1]},
    )
    planctl_dir = tmp_path / ".planctl"

    # Epic: read back through the canonical read path and re-normalize. The
    # second normalize is idempotent over an already-normalized record, so any
    # field the persisted JSON is missing (or carries differently) surfaces as
    # an inequality here.
    epic_on_disk = load_json(planctl_dir / "epics" / f"{epic_id}.json")
    assert normalize_epic(load_json(planctl_dir / "epics" / f"{epic_id}.json")) == (
        normalize_epic(dict(epic_on_disk))
    )
    assert epic_on_disk["id"] == epic_id
    assert epic_on_disk["snippets"] == ["snippet/a"]
    # Every optional field a fresh normalize would backfill is already present.
    assert epic_on_disk == normalize_epic(dict(epic_on_disk))

    # Tasks: same idempotence assertion per task.
    for i, task_id in enumerate(task_ids, start=1):
        task_on_disk = load_json(planctl_dir / "tasks" / f"{task_id}.json")
        assert task_on_disk == normalize_task(dict(task_on_disk))
        assert task_on_disk["id"] == task_id
        assert task_on_disk["epic"] == epic_id
    # Dep encoding survived the round-trip.
    task_two = load_json(planctl_dir / "tasks" / f"{epic_id}.2.json")
    assert task_two["depends_on"] == [f"{epic_id}.1"]


def test_seed_state_writes_four_section_specs(tmp_path):
    """Each task spec carries the four canonical headings; epic spec persists."""
    from planctl.models import TASK_SPEC_HEADINGS

    epic_id, task_ids = seed_state(tmp_path, epic_id="fn-3-seed", n_tasks=1)
    specs_dir = tmp_path / ".planctl" / "specs"

    epic_spec = (specs_dir / f"{epic_id}.md").read_text(encoding="utf-8")
    assert "## Overview" in epic_spec

    task_spec = (specs_dir / f"{task_ids[0]}.md").read_text(encoding="utf-8")
    for heading in TASK_SPEC_HEADINGS:
        assert heading in task_spec


def test_seed_state_no_git_dir(tmp_path):
    """seed_state mints a tree without git: no .git/ side effect."""
    seed_state(tmp_path, epic_id="fn-4-seed")
    assert not (tmp_path / ".git").exists()


def test_fixed_clock_pins_seed_timestamps(tmp_path, fixed_clock):
    """``fixed_clock`` freezes the ``now_iso()`` seed_state stamps."""
    epic_id, task_ids = seed_state(tmp_path, epic_id="fn-5-seed")
    epic = load_json(tmp_path / ".planctl" / "epics" / f"{epic_id}.json")
    assert epic["created_at"] == fixed_clock
    assert epic["updated_at"] == fixed_clock
    task = load_json(tmp_path / ".planctl" / "tasks" / f"{task_ids[0]}.json")
    assert task["created_at"] == fixed_clock


def test_isolated_roots_stubs_discovery(isolated_roots):
    """``isolated_roots`` forces project discovery to an empty list."""
    from planctl.discovery import discover_projects

    assert discover_projects() == []


def test_mock_sketch_refs_fakes_spawn(mock_sketch_refs):
    """``mock_sketch_refs`` intercepts the inline-sketch-refs spawn."""
    from planctl.sketch_refs import inline_sketch_refs_batch

    slots = inline_sketch_refs_batch(
        [{"bundles": ["sketch/x", "bundle/y"], "snippets": ["snippet/a"]}],
        project_root=Path("/tmp/whatever"),
    )
    assert len(mock_sketch_refs) == 1  # spawn happened
    # The sketch/ ref was dropped; bundle/ ref + snippet survived.
    assert slots[0].remaining_bundles == ["bundle/y"]
    assert slots[0].merged_snippets == ["snippet/a"]
