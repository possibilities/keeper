"""Tests for cross-project epic-level dependencies.

Mutating verbs resolve the session id from CLAUDE_CODE_SESSION_ID; these
tests set it explicitly.

Covers the global resolver primitive (``discovery.resolve_epic_globally``) and
the write-side rewires across ``epic add-dep`` / ``epic add-deps`` / scaffold,
plus the integrity / restamp gate's global existence + cycle universe.

Test matrix:

- ``resolve_epic_globally``: cwd hot path, cross-project resolution, not-found,
  ambiguous (legacy dup), single-repo fallback.
- ``epic add-dep`` cross-project happy path + ambiguous error envelope +
  not-found error.
- ``epic add-deps`` cross-project batch, ambiguous priority order, and
  ``--skip-invalid`` routing into ``SKIPPED_AMBIGUOUS``.
- ``planctl scaffold`` accepts a cross-project ``epic.depends_on_epics``;
  rejects when the dep id is ambiguous via ``epic_dep_invalid``.
- Integrity: cross-project A->B->A cycle is rejected by the post-write
  restamp gate; ``epic add-dep``'s ``BaseException`` rollback leaves disk
  untouched.
- Single-repo no-regression: unconfigured ``roots`` falls back to cwd cleanly.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from .conftest import _write_git_skeleton, run_cli, seed_epic, set_roots

# Every test here exercises cross-project epic resolution: the dep resolver and
# scaffold collision checks must run the REAL discovery scan against the
# ``two_projects`` / ``three_projects`` CONFIG_PATH tmp root (never the real
# ~/code). ``real_roots`` opts the whole file out of the autouse
# empty-discovery isolation onto that controlled root. Fast-path marker (NOT
# slow bucket): the fast gate runs these against the local tmp tree.
pytestmark = pytest.mark.real_roots

# ---------------------------------------------------------------------------
# Multi-project fixture: two planctl projects under one shared root.
# ---------------------------------------------------------------------------


def _git_init(proj: Path) -> None:
    """Write a bare ``.git/`` skeleton so scaffold's filesystem check passes.

    These tests assert on cross-project epic resolution, not on git history —
    repo detection needs only that ``.git/`` *exists* (integrity.py) and the
    fast bucket no-ops every real git verb (auto-commit, dirty-probe), so a
    hand-written skeleton is enough with zero ``git init`` subprocess. The
    same seam the ``project`` / ``multi_repo_project`` fixtures use.
    """
    _write_git_skeleton(proj)


def _planctl_init(proj: Path) -> None:
    result = run_cli(["init"])
    assert result.exit_code == 0, result.output


@pytest.fixture
def two_projects(request, tmp_path, monkeypatch):
    """Two planctl projects under one shared root; cwd starts in project B.

    Yields ``(root, proj_a, proj_b)`` where both are git-initialised planctl
    projects and ``CONFIG_PATH`` is overridden so discovery surfaces both.
    The CWD lands in project B so the resolver's cwd-then-global path kicks
    in: a local dep id (B's own epic) short-circuits cwd; a cross-project
    dep (an A epic) resolves via the global step.
    """
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-cross-project-fixture")

    root = tmp_path / "_xproject_root"
    root.mkdir()
    proj_a = root / "proj-a"
    proj_b = root / "proj-b"
    proj_a.mkdir()
    proj_b.mkdir()

    set_roots(request, monkeypatch, [root])

    # Stand up project A. `init` self-commits its bootstrap files inline, so
    # the baseline is clean once the verb returns — no manual commit needed.
    monkeypatch.chdir(proj_a)
    _git_init(proj_a)
    _planctl_init(proj_a)

    # Stand up project B (same self-committing init).
    monkeypatch.chdir(proj_b)
    _git_init(proj_b)
    _planctl_init(proj_b)

    # Leave cwd in project B for the cross-project-dep call sites.
    monkeypatch.chdir(proj_b)
    return root, proj_a, proj_b


@pytest.fixture
def three_projects(request, tmp_path, monkeypatch):
    """Three planctl projects under one shared root; cwd starts in project C.

    Like ``two_projects`` but adds a third project C so ambiguous-id tests can
    invoke from C while the dup id lives in A and B (not C). The cwd-first
    short-circuit in ``resolve_epic_globally`` correctly prefers a local copy
    when present — to actually exercise the ambiguous path, the caller's cwd
    must NOT carry the dup. ``three_projects`` provides exactly that
    neutral-cwd scenario.
    """
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-cross-project-fixture")

    root = tmp_path / "_xproject3_root"
    root.mkdir()
    proj_a = root / "proj-a"
    proj_b = root / "proj-b"
    proj_c = root / "proj-c"
    for p in (proj_a, proj_b, proj_c):
        p.mkdir()

    set_roots(request, monkeypatch, [root])

    for proj in (proj_a, proj_b, proj_c):
        monkeypatch.chdir(proj)
        _git_init(proj)
        # `init` self-commits its bootstrap files inline — clean baseline,
        # no manual stage+commit needed.
        _planctl_init(proj)

    monkeypatch.chdir(proj_c)
    return root, proj_a, proj_b, proj_c


def _invoke(args: list[str]):
    return run_cli(args)


def _parse_envelope(output: str) -> dict:
    for ln in output.strip().splitlines():
        stripped = ln.strip()
        if stripped.startswith("{"):
            return json.loads(stripped)
    raise AssertionError(f"No JSON line found in output: {output!r}")


def _read_epic_json(project_path: Path, epic_id: str) -> dict:
    p = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    return json.loads(p.read_text())


def _seed_epic_in(project_path: Path, monkeypatch, *, title: str) -> str:
    """Run ``scaffold`` from inside *project_path* and return the new epic id."""
    monkeypatch.chdir(project_path)
    epic_id, _tids = seed_epic(project_path, title=title, n_tasks=1)
    return epic_id


# ---------------------------------------------------------------------------
# resolve_epic_globally: cwd hot path, cross-project, not-found, ambiguous
# ---------------------------------------------------------------------------


@pytest.mark.python_only  # calls discovery.resolve_epic_globally in-process
def test_resolve_epic_globally_cwd_hot_path(two_projects, monkeypatch):
    """An epic in cwd's own project resolves via the cwd short-circuit."""
    from planctl.discovery import resolve_epic_globally

    _root, _proj_a, proj_b = two_projects
    epic_b = _seed_epic_in(proj_b, monkeypatch, title="Local B epic")

    res = resolve_epic_globally(epic_b)
    assert res.resolved
    assert res.project_path is not None
    assert res.project_path.resolve() == proj_b.resolve()
    assert res.epic_path == proj_b / ".planctl" / "epics" / f"{epic_b}.json"
    assert res.owners == []


@pytest.mark.python_only  # calls discovery.resolve_epic_globally in-process
def test_resolve_epic_globally_cross_project(two_projects, monkeypatch):
    """An epic in a sibling project resolves via the global discovery step."""
    from planctl.discovery import resolve_epic_globally

    _root, proj_a, proj_b = two_projects
    epic_a = _seed_epic_in(proj_a, monkeypatch, title="A epic")

    # Resolve from project B's cwd: not local, found globally in A.
    monkeypatch.chdir(proj_b)
    res = resolve_epic_globally(epic_a)
    assert res.resolved
    assert res.project_path is not None
    assert res.project_path.resolve() == proj_a.resolve()
    assert res.epic_path == proj_a / ".planctl" / "epics" / f"{epic_a}.json"


@pytest.mark.python_only  # calls discovery.resolve_epic_globally in-process
def test_resolve_epic_globally_not_found(two_projects):
    """An id that exists nowhere yields a ResolveResult with both fields None."""
    from planctl.discovery import resolve_epic_globally

    res = resolve_epic_globally("fn-9999-does-not-exist")
    assert not res.resolved
    assert not res.ambiguous
    assert res.project_path is None
    assert res.epic_path is None
    assert res.owners == []


@pytest.mark.python_only  # calls discovery.resolve_epic_globally in-process
def test_resolve_epic_globally_ambiguous(two_projects, monkeypatch):
    """Legacy dup state: same id in two projects → ambiguous, owners listed."""
    from planctl.discovery import resolve_epic_globally

    _root, proj_a, proj_b = two_projects
    epic_a = _seed_epic_in(proj_a, monkeypatch, title="Dup epic")
    # Hand-place an identical epic JSON in B to simulate legacy dup state.
    src = proj_a / ".planctl" / "epics" / f"{epic_a}.json"
    dst = proj_b / ".planctl" / "epics" / f"{epic_a}.json"
    dst.write_bytes(src.read_bytes())

    # Resolve from a neutral cwd (the root, NOT inside either project) so the
    # cwd hot path doesn't claim either. resolve_epic_globally must surface
    # ambiguous, not silently pick a winner.
    monkeypatch.chdir(_root)
    res = resolve_epic_globally(epic_a)
    assert res.ambiguous
    assert not res.resolved
    assert res.project_path is None
    owners = {p.resolve() for p in res.owners}
    assert proj_a.resolve() in owners
    assert proj_b.resolve() in owners


@pytest.mark.python_only  # calls discovery.resolve_epic_globally in-process
def test_resolve_epic_globally_single_repo_fallback(
    planctl_git_repo, monkeypatch, tmp_path
):
    """Unconfigured ``roots`` falls back to cwd cleanly (no regression)."""
    # Point CONFIG_PATH at an absent file so load_roots falls back to ~/code,
    # which doesn't contain this tmp project — discovery yields zero
    # candidates, only the cwd short-circuit can resolve.
    cfg = tmp_path / "_absent_roots.yaml"
    monkeypatch.setattr("planctl.config.CONFIG_PATH", cfg)

    from planctl.discovery import resolve_epic_globally

    # Seed a local epic + verify the resolver finds it via cwd.
    epic_id, _ = seed_epic(planctl_git_repo, title="Single-repo epic", n_tasks=1)
    res = resolve_epic_globally(epic_id)
    assert res.resolved
    assert res.project_path is not None
    assert res.project_path.resolve() == planctl_git_repo.resolve()


# ---------------------------------------------------------------------------
# number-only `fn-N` resolution (integer equality, normalize-on-write)
# ---------------------------------------------------------------------------


@pytest.mark.python_only  # calls discovery.resolve_epic_globally in-process
def test_resolve_epic_globally_number_only_cwd(two_projects, monkeypatch):
    """A bare `fn-N` resolves the cwd-local epic and returns its full slug id."""
    from planctl.discovery import resolve_epic_globally
    from planctl.ids import parse_id

    _root, _proj_a, proj_b = two_projects
    epic_b = _seed_epic_in(proj_b, monkeypatch, title="Local B epic")
    num, _ = parse_id(epic_b)

    res = resolve_epic_globally(f"fn-{num}")
    assert res.resolved
    assert res.resolved_id == epic_b
    assert res.project_path is not None
    assert res.project_path.resolve() == proj_b.resolve()


@pytest.mark.python_only  # calls discovery.resolve_epic_globally in-process
def test_resolve_epic_globally_number_only_cross_project(two_projects, monkeypatch):
    """A bare `fn-N` resolves a sibling-project epic via the global step."""
    from planctl.discovery import resolve_epic_globally
    from planctl.ids import parse_id

    _root, proj_a, proj_b = two_projects
    epic_a = _seed_epic_in(proj_a, monkeypatch, title="A epic")
    num, _ = parse_id(epic_a)

    monkeypatch.chdir(proj_b)
    res = resolve_epic_globally(f"fn-{num}")
    assert res.resolved
    assert res.resolved_id == epic_a
    assert res.project_path is not None
    assert res.project_path.resolve() == proj_a.resolve()


def test_add_deps_number_only_cross_project_collision_ambiguous(
    three_projects, monkeypatch
):
    """Same epic-number in two projects routes a bare `fn-N` to the ambiguous channel."""
    from planctl.ids import parse_id

    _root, proj_a, proj_b, proj_c = three_projects

    # Target epic lives in neutral project C and gets number 1 (per-project
    # numbering starts at 1). The colliding number must therefore be one C
    # does NOT carry — seed A and B up to a shared number >= 2.
    epic_c = _seed_epic_in(proj_c, monkeypatch, title="C target")
    num_c, _ = parse_id(epic_c)
    assert num_c is not None
    collide_num = num_c + 1

    # Seed A and B until each carries an epic with `collide_num`, so a bare
    # `fn-<collide_num>` resolves to two projects (and not to cwd's C). Each
    # mint needs a unique slug (scaffold rejects same-slug siblings).
    n = 0
    while True:
        epic_a = _seed_epic_in(proj_a, monkeypatch, title=f"A epic {n}")
        n += 1
        if parse_id(epic_a)[0] == collide_num:
            break
    while True:
        epic_b = _seed_epic_in(proj_b, monkeypatch, title=f"B epic {n}")
        n += 1
        if parse_id(epic_b)[0] == collide_num:
            break
    num_a = collide_num

    monkeypatch.chdir(proj_c)
    # Fail-loud: the bare number is ambiguous across A and B → dep_ambiguous_id.
    r = _invoke(["epic", "add-deps", epic_c, f"fn-{num_a}"])
    assert r.exit_code != 0, r.output
    payload = _parse_envelope(r.output)
    assert payload["success"] is False
    assert payload["error"]["code"] == "dep_ambiguous_id"
    # No silent pick: nothing wired on C's epic.
    assert _read_epic_json(proj_c, epic_c)["depends_on_epics"] == []

    # --skip-invalid routes the same collision into SKIPPED_AMBIGUOUS.
    r2 = _invoke(["epic", "add-deps", epic_c, f"fn-{num_a}", "--skip-invalid"])
    assert r2.exit_code == 0, r2.output
    payload2 = _parse_envelope(r2.output)
    statuses = {x["dep_id"]: x["status"] for x in payload2["results"]}
    assert statuses == {f"fn-{num_a}": "SKIPPED_AMBIGUOUS"}
    assert _read_epic_json(proj_c, epic_c)["depends_on_epics"] == []


# ---------------------------------------------------------------------------
# epic add-dep cross-project happy path + error envelopes
# ---------------------------------------------------------------------------


def test_add_dep_cross_project_happy_path(two_projects, monkeypatch):
    """Wire a dep from B's epic to A's epic — resolves globally, persists."""
    _root, proj_a, proj_b = two_projects
    epic_a = _seed_epic_in(proj_a, monkeypatch, title="A epic")
    epic_b = _seed_epic_in(proj_b, monkeypatch, title="B epic")

    monkeypatch.chdir(proj_b)
    r = _invoke(["epic", "add-dep", epic_b, epic_a])
    assert r.exit_code == 0, r.output

    # Edge landed on B's epic JSON, pointing at A's epic id.
    assert _read_epic_json(proj_b, epic_b)["depends_on_epics"] == [epic_a]
    # A's epic untouched.
    assert _read_epic_json(proj_a, epic_a)["depends_on_epics"] == []


def test_add_dep_cross_project_not_found(two_projects, monkeypatch):
    """An id that exists in no project errors with 'Epic not found'."""
    _root, _proj_a, proj_b = two_projects
    epic_b = _seed_epic_in(proj_b, monkeypatch, title="B epic")

    monkeypatch.chdir(proj_b)
    r = _invoke(["epic", "add-dep", epic_b, "fn-9999-missing"])
    assert r.exit_code != 0, r.output
    assert "Epic not found" in r.output


def test_add_dep_cross_project_ambiguous(three_projects, monkeypatch):
    """A dep id present in two foreign projects errors with 'multiple projects'.

    Ambiguity only kicks in when the cwd does NOT carry the dup — the cwd-
    first short-circuit correctly prefers a local copy, so we invoke from C
    while the dup lives in A and B.
    """
    _root, proj_a, proj_b, proj_c = three_projects
    # Seed a duplicate id across A and B (legacy dup state, neither is cwd).
    dup_id = _seed_epic_in(proj_a, monkeypatch, title="Dup")
    src = proj_a / ".planctl" / "epics" / f"{dup_id}.json"
    dst = proj_b / ".planctl" / "epics" / f"{dup_id}.json"
    dst.write_bytes(src.read_bytes())

    # Seed C's parent epic that wants to point at the ambiguous id.
    epic_c = _seed_epic_in(proj_c, monkeypatch, title="Parent")

    monkeypatch.chdir(proj_c)
    r = _invoke(["epic", "add-dep", epic_c, dup_id])
    assert r.exit_code != 0, r.output
    assert "multiple projects" in r.output
    # C's parent epic dep list must be untouched.
    assert _read_epic_json(proj_c, epic_c)["depends_on_epics"] == []


# ---------------------------------------------------------------------------
# epic add-deps cross-project batch + ambiguous + SKIPPED_AMBIGUOUS
# ---------------------------------------------------------------------------


def test_add_deps_cross_project_batch(two_projects, monkeypatch):
    """Batch wires a mix of in-project and cross-project edges."""
    _root, proj_a, proj_b = two_projects
    epic_a1 = _seed_epic_in(proj_a, monkeypatch, title="A1")
    epic_b_local = _seed_epic_in(proj_b, monkeypatch, title="B local")
    epic_b_parent = _seed_epic_in(proj_b, monkeypatch, title="B parent")

    monkeypatch.chdir(proj_b)
    r = _invoke(["epic", "add-deps", epic_b_parent, epic_a1, epic_b_local])
    assert r.exit_code == 0, r.output
    payload = _parse_envelope(r.output)
    statuses = {res["dep_id"]: res["status"] for res in payload["results"]}
    assert statuses == {epic_a1: "WIRED", epic_b_local: "WIRED"}
    assert _read_epic_json(proj_b, epic_b_parent)["depends_on_epics"] == [
        epic_a1,
        epic_b_local,
    ]


def test_add_deps_ambiguous_priority_order(three_projects, monkeypatch):
    """``dep_ambiguous_id`` slots between ``bad_id`` and ``epic_not_found``.

    Dup id lives in A and B; cwd is C so the cwd-first short-circuit does
    not claim either.
    """
    _root, proj_a, proj_b, proj_c = three_projects
    dup_id = _seed_epic_in(proj_a, monkeypatch, title="Dup")
    src = proj_a / ".planctl" / "epics" / f"{dup_id}.json"
    dst = proj_b / ".planctl" / "epics" / f"{dup_id}.json"
    dst.write_bytes(src.read_bytes())

    epic_c_parent = _seed_epic_in(proj_c, monkeypatch, title="Parent")

    monkeypatch.chdir(proj_c)
    # bad_id (malformed) + ambiguous + not-found in one call.
    r = _invoke(
        [
            "epic",
            "add-deps",
            epic_c_parent,
            "not-an-id",
            dup_id,
            "fn-9999-missing",
        ]
    )
    assert r.exit_code != 0, r.output
    payload = _parse_envelope(r.output)
    # bad_id wins the envelope (highest priority), but ambiguous + not-found
    # details ride along.
    assert payload["error"]["code"] == "bad_id"
    detail_blob = " | ".join(payload["error"]["details"])
    assert "not-an-id" in detail_blob
    assert dup_id in detail_blob
    assert "fn-9999-missing" in detail_blob


def test_add_deps_ambiguous_alone_picks_code(three_projects, monkeypatch):
    """When only ambiguous edges are present, ``dep_ambiguous_id`` is the code.

    Dup id lives in A and B; cwd is C so the cwd-first short-circuit does
    not claim either.
    """
    _root, proj_a, proj_b, proj_c = three_projects
    dup_id = _seed_epic_in(proj_a, monkeypatch, title="Dup")
    src = proj_a / ".planctl" / "epics" / f"{dup_id}.json"
    dst = proj_b / ".planctl" / "epics" / f"{dup_id}.json"
    dst.write_bytes(src.read_bytes())

    epic_c_parent = _seed_epic_in(proj_c, monkeypatch, title="Parent")

    monkeypatch.chdir(proj_c)
    r = _invoke(["epic", "add-deps", epic_c_parent, dup_id])
    assert r.exit_code != 0, r.output
    payload = _parse_envelope(r.output)
    assert payload["error"]["code"] == "dep_ambiguous_id"
    assert any("multiple projects" in d for d in payload["error"]["details"])
    # Nothing wired.
    assert _read_epic_json(proj_c, epic_c_parent)["depends_on_epics"] == []


def test_add_deps_skip_invalid_routes_ambiguous(three_projects, monkeypatch):
    """``--skip-invalid``: ambiguous lands as ``SKIPPED_AMBIGUOUS``, distinct from NOT_FOUND.

    Dup id lives in A and B; cwd is C; a valid cross-project dep from B
    lands. Verifies SKIPPED_AMBIGUOUS is a distinct status from
    SKIPPED_NOT_FOUND.
    """
    _root, proj_a, proj_b, proj_c = three_projects
    dup_id = _seed_epic_in(proj_a, monkeypatch, title="Dup")
    src = proj_a / ".planctl" / "epics" / f"{dup_id}.json"
    dst = proj_b / ".planctl" / "epics" / f"{dup_id}.json"
    dst.write_bytes(src.read_bytes())

    epic_b_valid = _seed_epic_in(proj_b, monkeypatch, title="B valid")
    epic_c_parent = _seed_epic_in(proj_c, monkeypatch, title="Parent")

    monkeypatch.chdir(proj_c)
    r = _invoke(
        [
            "epic",
            "add-deps",
            "--skip-invalid",
            epic_c_parent,
            dup_id,
            "fn-9999-missing",
            epic_b_valid,
        ]
    )
    assert r.exit_code == 0, r.output
    payload = _parse_envelope(r.output)
    statuses = {res["dep_id"]: res["status"] for res in payload["results"]}
    assert statuses == {
        dup_id: "SKIPPED_AMBIGUOUS",
        "fn-9999-missing": "SKIPPED_NOT_FOUND",
        epic_b_valid: "WIRED",
    }
    # Only the valid cross-project edge landed.
    assert _read_epic_json(proj_c, epic_c_parent)["depends_on_epics"] == [epic_b_valid]


# ---------------------------------------------------------------------------
# scaffold accepts cross-project depends_on_epics; rejects ambiguous
# ---------------------------------------------------------------------------


_VALID_TASK_SPEC = """\
## Description
Implement.

## Acceptance
- [ ] It works.

## Done summary

## Evidence
"""


def _scaffold_yaml(*, title: str, dep_ids: list[str]) -> str:
    indented_spec = "\n".join("      " + ln for ln in _VALID_TASK_SPEC.splitlines())
    deps_line = ""
    if dep_ids:
        deps_line = f"  depends_on_epics: [{', '.join(dep_ids)}]\n"
    return (
        f"epic:\n"
        f"  title: {title}\n"
        f"{deps_line}"
        f"  spec: |\n    ## Overview\n    x.\n"
        f"tasks:\n"
        f"  - title: T1\n    deps: []\n    tier: medium\n    spec: |\n{indented_spec}\n"
    )


def test_scaffold_accepts_cross_project_dep(two_projects, monkeypatch):
    """A declared cross-project ``depends_on_epics`` id passes pre-write validation."""
    _root, proj_a, proj_b = two_projects
    epic_a = _seed_epic_in(proj_a, monkeypatch, title="A epic")

    monkeypatch.chdir(proj_b)
    yaml_path = proj_b / "plan.yaml"
    yaml_path.write_text(
        _scaffold_yaml(title="B cross-dep epic", dep_ids=[epic_a]),
        encoding="utf-8",
    )
    r = _invoke(["scaffold", "--file", str(yaml_path)])
    assert r.exit_code == 0, r.output
    payload = _parse_envelope(r.output)
    new_epic_id = payload["epic_id"]
    assert _read_epic_json(proj_b, new_epic_id)["depends_on_epics"] == [epic_a]


def test_scaffold_rejects_ambiguous_cross_project_dep(three_projects, monkeypatch):
    """A duped cross-project dep id is rejected with ``epic_dep_invalid``.

    Dup id lives in A and B; cwd is C (where the new epic is being minted)
    so the cwd-first short-circuit does not claim either.
    """
    _root, proj_a, proj_b, proj_c = three_projects
    dup_id = _seed_epic_in(proj_a, monkeypatch, title="Dup")
    src = proj_a / ".planctl" / "epics" / f"{dup_id}.json"
    dst = proj_b / ".planctl" / "epics" / f"{dup_id}.json"
    dst.write_bytes(src.read_bytes())

    monkeypatch.chdir(proj_c)
    yaml_path = proj_c / "plan.yaml"
    yaml_path.write_text(
        _scaffold_yaml(title="C dup-dep epic", dep_ids=[dup_id]),
        encoding="utf-8",
    )
    r = _invoke(["scaffold", "--file", str(yaml_path)])
    assert r.exit_code != 0, r.output
    payload = _parse_envelope(r.output)
    assert payload["error"]["code"] == "epic_dep_invalid"
    assert any("multiple projects" in d for d in payload["error"]["details"]), payload[
        "error"
    ]["details"]


# ---------------------------------------------------------------------------
# Integrity: cross-project A->B->A cycle rejected by post-write restamp
# ---------------------------------------------------------------------------


def test_cross_project_cycle_rejected_and_rolled_back(two_projects, monkeypatch):
    """A->B->A across two projects: post-write restamp rejects + rollback fires."""
    _root, proj_a, proj_b = two_projects
    epic_a = _seed_epic_in(proj_a, monkeypatch, title="A")
    epic_b = _seed_epic_in(proj_b, monkeypatch, title="B")

    # First leg: A -> B (wire dep from A to B). Local to proj_a's resolver
    # cwd path; B's id resolves via the global step.
    monkeypatch.chdir(proj_a)
    r1 = _invoke(["epic", "add-dep", epic_a, epic_b])
    assert r1.exit_code == 0, r1.output
    assert _read_epic_json(proj_a, epic_a)["depends_on_epics"] == [epic_b]

    # Second leg: B -> A (would close the cycle A -> B -> A across projects).
    # Post-write restamp gate must reject AND ``BaseException`` rollback in
    # ``run_epic_add_dep.py`` must leave B's dep list empty on disk.
    monkeypatch.chdir(proj_b)
    r2 = _invoke(["epic", "add-dep", epic_b, epic_a])
    assert r2.exit_code != 0, r2.output
    payload = _parse_envelope(r2.output)
    assert payload["success"] is False
    err = payload["error"]
    assert err["code"] == "integrity_failed" or any(
        "epic-dep cycle detected" in d for d in err.get("details", [])
    )
    # Rollback: B's depends_on_epics must be empty on disk.
    assert _read_epic_json(proj_b, epic_b)["depends_on_epics"] == []


# ---------------------------------------------------------------------------
# guarded discover_projects() in the cycle-detection block
# ---------------------------------------------------------------------------


@pytest.mark.python_only  # injects an in-process discover_projects failure
def test_add_deps_discover_projects_raises_degrades_gracefully(
    two_projects, monkeypatch
):
    """If ``discover_projects()`` raises inside the cycle-detection block,
    ``epic add-deps`` must still succeed by degrading to "no global projects"
    (mirrors integrity.py:479-482 + validation_restamp.py:153-156). Without
    the guard, the exception propagates and the verb fails.
    """
    _root, _proj_a, proj_b = two_projects
    # Wire the dep purely within proj_b so dep-resolution does not need
    # discover_projects (which we're about to break). The only remaining
    # call site is the cycle-detection block at run_epic_add_deps.py:237.
    epic_parent = _seed_epic_in(proj_b, monkeypatch, title="B parent epic")
    epic_dep = _seed_epic_in(proj_b, monkeypatch, title="B dep epic")

    def _boom():
        raise RuntimeError("simulated discovery failure")

    monkeypatch.setattr("planctl.discovery.discover_projects", _boom)

    monkeypatch.chdir(proj_b)
    r = _invoke(["epic", "add-deps", epic_parent, epic_dep])
    assert r.exit_code == 0, r.output
    # Edge still landed on the parent epic despite discovery raising in the
    # cycle-detection block — the guard degrades to "no global projects" and
    # the local backstop walk still seeds the cycle graph.
    assert _read_epic_json(proj_b, epic_parent)["depends_on_epics"] == [epic_dep]
