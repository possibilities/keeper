"""Tests for scripts/migrate_approval_to_sidecar.py (fn-732 task .2).

The script is a PEP 723 one-shot; we import its functions directly via
importlib (it has no third-party deps, so the module body is importable).

Coverage:
  - SEED pass mirrors def approvals into sidecars, idempotently.
  - SEED fill-if-absent: never clobbers a sidecar-canonical approval.
  - SEED preserves existing sidecar fields (status, assignee).
  - --dry-run mutates nothing (both passes).
  - STRIP pass pops def approval cleanly AFTER a seed.
  - STRIP refuses (per-file) when the sidecar hasn't been seeded.
  - Roots discovery is monkeypatched to the tmp tree.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

_SCRIPT = (
    Path(__file__).resolve().parent.parent
    / "scripts"
    / "migrate_approval_to_sidecar.py"
)


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "migrate_approval_to_sidecar", _SCRIPT
    )
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _make_project(root: Path, name: str) -> Path:
    planctl = root / name / ".planctl"
    (planctl / "epics").mkdir(parents=True)
    (planctl / "tasks").mkdir(parents=True)
    return planctl


def _write_json(path: Path, obj: dict) -> None:
    path.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _point_roots(mod, monkeypatch, root: Path) -> None:
    monkeypatch.setattr(mod, "_list_roots", lambda: [root])


# ---------------------------------------------------------------------------
# SEED pass
# ---------------------------------------------------------------------------


def test_seed_mirrors_def_approval_into_sidecar(tmp_path, monkeypatch):
    mod = _load_module()
    planctl = _make_project(tmp_path, "proj")
    _write_json(
        planctl / "epics" / "fn-1-x.json", {"id": "fn-1-x", "approval": "approved"}
    )
    _write_json(
        planctl / "tasks" / "fn-1-x.1.json",
        {"id": "fn-1-x.1", "approval": "rejected"},
    )
    _point_roots(mod, monkeypatch, tmp_path)

    rc = mod.main([])
    assert rc == 0

    epic_side = _read_json(planctl / "state" / "epics" / "fn-1-x.state.json")
    assert epic_side["approval"] == "approved"
    task_side = _read_json(planctl / "state" / "tasks" / "fn-1-x.1.state.json")
    assert task_side["approval"] == "rejected"


def test_seed_is_idempotent(tmp_path, monkeypatch):
    mod = _load_module()
    planctl = _make_project(tmp_path, "proj")
    _write_json(
        planctl / "epics" / "fn-1-x.json", {"id": "fn-1-x", "approval": "approved"}
    )
    _point_roots(mod, monkeypatch, tmp_path)

    assert mod.main([]) == 0
    first = _read_json(planctl / "state" / "epics" / "fn-1-x.state.json")
    assert mod.main([]) == 0
    second = _read_json(planctl / "state" / "epics" / "fn-1-x.state.json")
    assert first == second


def test_seed_fill_if_absent_never_clobbers_sidecar(tmp_path, monkeypatch):
    """A sidecar that already carries approval is never overwritten by the def."""
    mod = _load_module()
    planctl = _make_project(tmp_path, "proj")
    # Def says pending; sidecar already says approved (the canonical value).
    _write_json(
        planctl / "tasks" / "fn-1-x.1.json", {"id": "fn-1-x.1", "approval": "pending"}
    )
    side_path = planctl / "state" / "tasks" / "fn-1-x.1.state.json"
    side_path.parent.mkdir(parents=True)
    _write_json(side_path, {"status": "done", "approval": "approved"})
    _point_roots(mod, monkeypatch, tmp_path)

    assert mod.main([]) == 0
    side = _read_json(side_path)
    assert side["approval"] == "approved", "seed clobbered a sidecar-canonical value"
    assert side["status"] == "done"


def test_seed_preserves_existing_sidecar_fields(tmp_path, monkeypatch):
    mod = _load_module()
    planctl = _make_project(tmp_path, "proj")
    _write_json(
        planctl / "tasks" / "fn-1-x.1.json", {"id": "fn-1-x.1", "approval": "approved"}
    )
    side_path = planctl / "state" / "tasks" / "fn-1-x.1.state.json"
    side_path.parent.mkdir(parents=True)
    _write_json(side_path, {"status": "done", "assignee": "alice"})
    _point_roots(mod, monkeypatch, tmp_path)

    assert mod.main([]) == 0
    side = _read_json(side_path)
    assert side["approval"] == "approved"
    assert side["status"] == "done"
    assert side["assignee"] == "alice"


def test_seed_skips_def_without_approval(tmp_path, monkeypatch):
    mod = _load_module()
    planctl = _make_project(tmp_path, "proj")
    _write_json(planctl / "epics" / "fn-1-x.json", {"id": "fn-1-x", "status": "open"})
    _point_roots(mod, monkeypatch, tmp_path)

    assert mod.main([]) == 0
    assert not (planctl / "state" / "epics" / "fn-1-x.state.json").exists()


def test_seed_dry_run_mutates_nothing(tmp_path, monkeypatch):
    mod = _load_module()
    planctl = _make_project(tmp_path, "proj")
    _write_json(
        planctl / "epics" / "fn-1-x.json", {"id": "fn-1-x", "approval": "approved"}
    )
    _point_roots(mod, monkeypatch, tmp_path)

    assert mod.main(["--dry-run"]) == 0
    assert not (planctl / "state" / "epics" / "fn-1-x.state.json").exists()
    # Def untouched.
    assert _read_json(planctl / "epics" / "fn-1-x.json")["approval"] == "approved"


# ---------------------------------------------------------------------------
# STRIP pass
# ---------------------------------------------------------------------------


def test_strip_pops_def_approval_after_seed(tmp_path, monkeypatch):
    mod = _load_module()
    planctl = _make_project(tmp_path, "proj")
    _write_json(
        planctl / "epics" / "fn-1-x.json", {"id": "fn-1-x", "approval": "approved"}
    )
    _write_json(
        planctl / "tasks" / "fn-1-x.1.json",
        {"id": "fn-1-x.1", "approval": "rejected"},
    )
    _point_roots(mod, monkeypatch, tmp_path)

    assert mod.main([]) == 0  # seed
    assert mod.main(["--strip"]) == 0  # strip

    epic_def = _read_json(planctl / "epics" / "fn-1-x.json")
    assert "approval" not in epic_def
    task_def = _read_json(planctl / "tasks" / "fn-1-x.1.json")
    assert "approval" not in task_def
    # Sidecar still carries the value.
    assert (
        _read_json(planctl / "state" / "epics" / "fn-1-x.state.json")["approval"]
        == "approved"
    )


def test_strip_refuses_without_seed(tmp_path, monkeypatch):
    """STRIP must not pop a def whose value isn't mirrored in the sidecar."""
    mod = _load_module()
    planctl = _make_project(tmp_path, "proj")
    _write_json(
        planctl / "epics" / "fn-1-x.json", {"id": "fn-1-x", "approval": "approved"}
    )
    _point_roots(mod, monkeypatch, tmp_path)

    # No seed first — strip should refuse to pop.
    assert mod.main(["--strip"]) == 0
    epic_def = _read_json(planctl / "epics" / "fn-1-x.json")
    assert epic_def.get("approval") == "approved", "strip popped without a seed"


def test_strip_dry_run_mutates_nothing(tmp_path, monkeypatch):
    mod = _load_module()
    planctl = _make_project(tmp_path, "proj")
    _write_json(
        planctl / "epics" / "fn-1-x.json", {"id": "fn-1-x", "approval": "approved"}
    )
    _point_roots(mod, monkeypatch, tmp_path)

    assert mod.main([]) == 0  # seed (real)
    assert mod.main(["--strip", "--dry-run"]) == 0
    # Def still carries approval — dry-run strip touched nothing.
    assert _read_json(planctl / "epics" / "fn-1-x.json")["approval"] == "approved"


def test_strip_is_idempotent(tmp_path, monkeypatch):
    mod = _load_module()
    planctl = _make_project(tmp_path, "proj")
    _write_json(
        planctl / "tasks" / "fn-1-x.1.json",
        {"id": "fn-1-x.1", "approval": "approved"},
    )
    _point_roots(mod, monkeypatch, tmp_path)

    assert mod.main([]) == 0
    assert mod.main(["--strip"]) == 0
    first = _read_json(planctl / "tasks" / "fn-1-x.1.json")
    assert mod.main(["--strip"]) == 0
    second = _read_json(planctl / "tasks" / "fn-1-x.1.json")
    assert first == second
    assert "approval" not in second


def test_multiple_projects_under_root(tmp_path, monkeypatch):
    mod = _load_module()
    p1 = _make_project(tmp_path, "proj-a")
    p2 = _make_project(tmp_path, "proj-b")
    _write_json(p1 / "epics" / "fn-1-a.json", {"id": "fn-1-a", "approval": "approved"})
    _write_json(p2 / "epics" / "fn-2-b.json", {"id": "fn-2-b", "approval": "rejected"})
    _point_roots(mod, monkeypatch, tmp_path)

    assert mod.main([]) == 0
    assert (
        _read_json(p1 / "state" / "epics" / "fn-1-a.state.json")["approval"]
        == "approved"
    )
    assert (
        _read_json(p2 / "state" / "epics" / "fn-2-b.state.json")["approval"]
        == "rejected"
    )
