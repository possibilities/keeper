"""Tests for planctl roots config + multi-project discovery + epic-id allocation.

fn-614 task .3: session-id env renamed JOBCTL_SESSION_ID → PLANCTL_SESSION_ID.

Covers:
- config loader: present / absent→default / malformed→default / path expansion
- discovery: roots with/without .planctl children, nested-.planctl skip, missing root
- scan_epic_ids_global across >=2 fake project dirs
- per-project numbering: each project gets its own monotonic fn-N
- global-name uniqueness: two projects can never mint the same full epic id
"""

from __future__ import annotations

import json
import os

from click.testing import CliRunner
from planctl.cli import cli
from planctl.config import load_roots
from planctl.discovery import discover_projects
from planctl.ids import scan_epic_ids_global

_ENV = {**os.environ, "PLANCTL_SESSION_ID": "test-roots-discovery-fixture"}


# --------------------------------------------------------------------------
# config loader
# --------------------------------------------------------------------------


def test_load_roots_absent_defaults_to_code(tmp_path):
    """Absent config file → default [~/code]."""
    missing = tmp_path / "no-such-config.yaml"
    roots = load_roots(missing)
    assert [str(r) for r in roots] == [os.path.realpath(os.path.expanduser("~/code"))]


def test_load_roots_present_expands_and_resolves(tmp_path):
    """Present config with roots: list → each entry expanduser'd + resolved."""
    a = tmp_path / "projects-a"
    b = tmp_path / "projects-b"
    a.mkdir()
    b.mkdir()
    cfg = tmp_path / "config.yaml"
    cfg.write_text(f"roots:\n  - {a}\n  - {b}\n", encoding="utf-8")

    roots = load_roots(cfg)
    assert roots == [a.resolve(), b.resolve()]


def test_load_roots_tilde_expansion(tmp_path):
    """A ~ entry is expanded to an absolute home-relative path."""
    cfg = tmp_path / "config.yaml"
    cfg.write_text("roots:\n  - ~/some-dir\n", encoding="utf-8")
    roots = load_roots(cfg)
    assert len(roots) == 1
    assert str(roots[0]) == os.path.realpath(os.path.expanduser("~/some-dir"))
    assert "~" not in str(roots[0])


def test_load_roots_malformed_yaml_falls_back(tmp_path):
    """Malformed YAML → default, no crash."""
    cfg = tmp_path / "config.yaml"
    cfg.write_text("roots: [unterminated\n  - oops:::", encoding="utf-8")
    roots = load_roots(cfg)
    assert [str(r) for r in roots] == [os.path.realpath(os.path.expanduser("~/code"))]


def test_load_roots_wrong_type_falls_back(tmp_path):
    """roots: that isn't a list → default."""
    cfg = tmp_path / "config.yaml"
    cfg.write_text("roots: not-a-list\n", encoding="utf-8")
    roots = load_roots(cfg)
    assert [str(r) for r in roots] == [os.path.realpath(os.path.expanduser("~/code"))]


def test_load_roots_drops_nonstring_entries(tmp_path):
    """Non-string / empty entries are dropped; valid ones kept."""
    valid = tmp_path / "valid"
    valid.mkdir()
    cfg = tmp_path / "config.yaml"
    cfg.write_text(f"roots:\n  - {valid}\n  - 42\n  - ''\n", encoding="utf-8")
    roots = load_roots(cfg)
    assert roots == [valid.resolve()]


def test_load_roots_empty_list_falls_back(tmp_path):
    """An empty roots list falls back to the default so callers get >=1 root."""
    cfg = tmp_path / "config.yaml"
    cfg.write_text("roots: []\n", encoding="utf-8")
    roots = load_roots(cfg)
    assert [str(r) for r in roots] == [os.path.realpath(os.path.expanduser("~/code"))]


# --------------------------------------------------------------------------
# discovery
# --------------------------------------------------------------------------


def _make_planctl_project(parent, name):
    proj = parent / name
    (proj / ".planctl" / "epics").mkdir(parents=True)
    (proj / ".planctl" / "specs").mkdir(parents=True)
    return proj


def test_discover_finds_immediate_children(tmp_path):
    root = tmp_path / "code"
    root.mkdir()
    p1 = _make_planctl_project(root, "alpha")
    p2 = _make_planctl_project(root, "beta")
    # A non-planctl sibling is ignored.
    (root / "gamma").mkdir()

    found = discover_projects([root])
    assert found == sorted([p1, p2])


def test_discover_skips_nested_planctl(tmp_path):
    """A nested .planctl/ (worktree) under a project must NOT be surfaced."""
    root = tmp_path / "code"
    root.mkdir()
    proj = _make_planctl_project(root, "alpha")
    # Agent worktree: <project>/.claude/worktrees/<id>/.planctl/
    nested = proj / ".claude" / "worktrees" / "wt1"
    (nested / ".planctl" / "epics").mkdir(parents=True)

    found = discover_projects([root])
    assert found == [proj]
    assert nested not in found


def test_discover_missing_root_skipped(tmp_path):
    """A root that doesn't exist is skipped, not an error."""
    real_root = tmp_path / "code"
    real_root.mkdir()
    proj = _make_planctl_project(real_root, "alpha")
    missing = tmp_path / "does-not-exist"

    found = discover_projects([missing, real_root])
    assert found == [proj]


def test_discover_dedups_across_roots(tmp_path):
    """Same project reachable via duplicate roots appears once."""
    root = tmp_path / "code"
    root.mkdir()
    proj = _make_planctl_project(root, "alpha")
    found = discover_projects([root, root])
    assert found == [proj]


# --------------------------------------------------------------------------
# scan_epic_ids_global
# --------------------------------------------------------------------------


def _seed_epic(proj, epic_id):
    (proj / ".planctl" / "epics").mkdir(parents=True, exist_ok=True)
    (proj / ".planctl" / "epics" / f"{epic_id}.json").write_text("{}", encoding="utf-8")


def test_scan_epic_ids_global_across_projects(tmp_path):
    root = tmp_path / "code"
    root.mkdir()
    p1 = root / "alpha"
    p2 = root / "beta"
    _seed_epic(p1, "fn-7-foo")
    _seed_epic(p2, "fn-42-bar")
    _seed_epic(p2, "fn-13-baz")

    owners = scan_epic_ids_global([p1, p2])
    assert owners == {"fn-7-foo": p1, "fn-42-bar": p2, "fn-13-baz": p2}


def test_scan_epic_ids_global_empty(tmp_path):
    p1 = tmp_path / "alpha"
    p1.mkdir()
    # No .planctl/ at all.
    assert scan_epic_ids_global([p1]) == {}


# --------------------------------------------------------------------------
# per-project numbering + global-name uniqueness across creates
# --------------------------------------------------------------------------


def _extract_epic_id(output):
    """Scan CLI output for the first JSON line carrying an ``epic`` key.

    Tolerates stdout noise (e.g. "planctl.audit: emit failed: ..." when the
    jobctl UDS audit socket is down).
    """
    for line in output.strip().splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict) and "epic" in payload:
            return payload["epic"]["id"]
    raise AssertionError(f"No epic payload found in output:\n{output}")


def test_creates_are_per_project_numbered(tmp_path, monkeypatch):
    """Two project dirs under one root; each project gets its own monotonic fn-N.

    With per-project numbering, project A's first epic is fn-1 and project B's
    first epic is ALSO fn-1 — discovery no longer participates in the number.
    """
    monkeypatch.setenv("PLANCTL_SESSION_ID", "test-roots-discovery-fixture")

    root = tmp_path / "code"
    root.mkdir()
    proj_a = root / "alpha"
    proj_b = root / "beta"
    proj_a.mkdir()
    proj_b.mkdir()

    cfg = tmp_path / "config.yaml"
    cfg.write_text(f"roots:\n  - {root}\n", encoding="utf-8")
    monkeypatch.setattr("planctl.config.CONFIG_PATH", cfg)

    runner = CliRunner()

    def _create(cwd, title):
        monkeypatch.chdir(cwd)
        init = runner.invoke(cli, ["init"], env=_ENV)
        assert init.exit_code == 0, init.output
        res = runner.invoke(cli, ["epic", "create", "--title", title], env=_ENV)
        assert res.exit_code == 0, res.output
        return _extract_epic_id(res.output)

    id_a = _create(proj_a, "Alpha epic")
    id_b = _create(proj_b, "Beta epic")

    n_a = int(id_a.split("-")[1])
    n_b = int(id_b.split("-")[1])
    assert n_a == 1 and n_b == 1, f"Expected fn-1 in both, got {id_a}, {id_b}"


def test_create_rejects_global_name_collision(tmp_path, monkeypatch):
    """When two projects would mint the same full epic id, the second fails."""
    monkeypatch.setenv("PLANCTL_SESSION_ID", "test-roots-discovery-fixture")

    root = tmp_path / "code"
    root.mkdir()
    proj_a = root / "alpha"
    proj_b = root / "beta"
    proj_a.mkdir()
    proj_b.mkdir()

    cfg = tmp_path / "config.yaml"
    cfg.write_text(f"roots:\n  - {root}\n", encoding="utf-8")
    monkeypatch.setattr("planctl.config.CONFIG_PATH", cfg)

    runner = CliRunner()

    monkeypatch.chdir(proj_a)
    assert runner.invoke(cli, ["init"], env=_ENV).exit_code == 0
    res_a = runner.invoke(cli, ["epic", "create", "--title", "Shared title"], env=_ENV)
    assert res_a.exit_code == 0, res_a.output
    id_a = _extract_epic_id(res_a.output)

    monkeypatch.chdir(proj_b)
    assert runner.invoke(cli, ["init"], env=_ENV).exit_code == 0
    res_b = runner.invoke(cli, ["epic", "create", "--title", "Shared title"], env=_ENV)
    assert res_b.exit_code != 0, (
        f"expected collision failure, got success with output:\n{res_b.output}"
    )
    assert id_a in res_b.output, (
        f"expected error to name the colliding id {id_a}; got:\n{res_b.output}"
    )
