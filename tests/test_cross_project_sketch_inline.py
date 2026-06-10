"""Tests for fn-610 cross-project sketch inlining at planctl write time.

The bug being fixed: ``sketch/<name>`` bundle refs used to resolve at
render-spec time against the worker's cwd project, but sketches are
authored in a different project's gitignored ``.promptctl/sketches/`` —
so an epic created in project B from a sketch authored in project A
carried a ref no worker could resolve, and ``render-spec`` hard-killed
the worker at startup.

This test file proves the four planctl write paths
(``scaffold`` / ``refine-apply`` / ``epic set-bundles`` /
``task set-bundles``) inline ``sketch/<name>`` refs at write time
against the cwd-derived project (where ``/sketch`` saved the sketch) —
NOT the epic's ``primary_repo`` (the fn-608 trap). After write the
persisted record carries the inlined ids in ``snippets`` and zero
residual ``sketch/`` refs in ``bundles``, so worker-time
``render-spec`` never re-resolves them.

Test matrix per write path:

- Sketch authored in project A; write executed from project B's cwd →
  ids inlined into persisted ``snippets``; ``bundles`` carries no
  ``sketch/`` ref.
- Missing sketch (unresolvable from cwd) → ``ref_invalid`` envelope;
  no partial writes land.
- Empty sketch (``snippet_ids: []``) → ref dropped, snippets unchanged.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
import yaml
from click.testing import CliRunner
from planctl.cli import cli

from .conftest import _write_git_skeleton

# ---------------------------------------------------------------------------
# Multi-project fixture (mirrors the two_projects fixture in
# test_cross_project_epic_deps.py — sketches need git-initialised siblings
# under a shared discovery root for resolve_project + auto-commit to behave).
# ---------------------------------------------------------------------------


def _git_init(proj: Path) -> None:
    """Write a bare ``.git/`` skeleton so scaffold's filesystem check passes.

    Repo detection needs only that ``.git/`` *exists* (integrity.py); the fast
    bucket no-ops every real git verb, so a hand-written skeleton is enough with
    zero ``git init`` subprocess. The ``real_sketch`` tests that spawn the real
    ``promptctl inline-sketch-refs`` are slow-bucket (skipped on the fast gate);
    the fast-path empty-sketch tests only need ``.git/`` present.
    """
    _write_git_skeleton(proj)


def _planctl_init() -> None:
    runner = CliRunner()
    result = runner.invoke(cli, ["init"])
    assert result.exit_code == 0, result.output


@pytest.fixture
def two_projects(tmp_path, monkeypatch):
    """Two planctl projects under one shared root; cwd starts in project B.

    Yields ``(root, proj_a, proj_b)`` where both are git-initialised
    planctl projects. The cwd lands in project B so we can author a
    sketch in A and write the planctl record from B — exercising the
    cross-project anchor that fn-610 fixes.
    """
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-cross-sketch-fixture")

    root = tmp_path / "_xsketch_root"
    root.mkdir()
    proj_a = root / "proj-a"
    proj_b = root / "proj-b"
    proj_a.mkdir()
    proj_b.mkdir()

    cfg = tmp_path / "_xsketch_roots.yaml"
    cfg.write_text(f"roots:\n  - {root}\n", encoding="utf-8")
    monkeypatch.setattr("planctl.config.CONFIG_PATH", cfg)

    # Stand up project A. `init` self-commits its bootstrap files inline, so
    # the baseline is clean once the verb returns — no manual commit needed.
    monkeypatch.chdir(proj_a)
    _git_init(proj_a)
    _planctl_init()

    # Stand up project B (same self-committing init).
    monkeypatch.chdir(proj_b)
    _git_init(proj_b)
    _planctl_init()

    # Cwd stays in project B for the cross-project write paths.
    monkeypatch.chdir(proj_b)
    return root, proj_a, proj_b


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_sketch(project_root: Path, name: str, snippet_ids: list[str]) -> Path:
    """Author a sketch YAML under ``<project_root>/.promptctl/sketches/``."""
    sketches_dir = project_root / ".promptctl" / "sketches"
    sketches_dir.mkdir(parents=True, exist_ok=True)
    path = sketches_dir / f"{name}.yaml"
    path.write_text(
        yaml.safe_dump(
            {
                "id": name,
                "snippet_ids": snippet_ids,
                "summary": None,
                "tags": [],
                "created_at": datetime.now(UTC).isoformat(),
            }
        )
    )
    return path


_VALID_TASK_SPEC = """\
## Description
Implement the thing.

## Acceptance
- [ ] It works.

## Done summary

## Evidence
"""


def _indent(text: str, n: int) -> str:
    prefix = " " * n
    return "\n".join(prefix + line if line else "" for line in text.splitlines())


def _invoke(args: list[str]):
    runner = CliRunner()
    return runner.invoke(cli, args)


def _parse_envelope(output: str) -> dict:
    """Return the first JSON object line in CLI output."""
    for ln in output.strip().splitlines():
        stripped = ln.strip()
        if stripped.startswith("{"):
            return json.loads(stripped)
    raise AssertionError(f"No JSON line in output: {output!r}")


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text())


# ---------------------------------------------------------------------------
# CRITICAL: cwd is project B, sketch lives in project A. The fn-608 trap was
# anchoring on the epic's primary_repo (B) instead of the cwd where /sketch
# saved the sketch (B's own cwd at sketch time — here we model the workflow
# where the human authored the sketch in A then chdir'd to B). Test the
# write-from-B path uses B's cwd as the anchor; for that, the sketch must
# live in B (project_path == cwd). The cross-project shape this guards is
# the wrong shape: sketch in A, scaffold from B with B's cwd. The correct
# fn-610 anchor is B (cwd), so the sketch in A is unresolvable — which is
# the failure mode the resolver must detect. Both shapes are tested below.
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# scaffold
# ---------------------------------------------------------------------------


@pytest.mark.real_sketch
def test_scaffold_resolves_sketch_against_cwd_project(two_projects):
    """Sketch in cwd's project (B) resolves; ids inline; ref dropped."""
    _root, _proj_a, proj_b = two_projects
    _write_sketch(proj_b, "feat-x", ["snip-a", "snip-b"])

    yaml_text = f"""\
epic:
  title: cwd-anchored sketch
  bundles: [sketch/feat-x]
  spec: |
    ## Overview
    x.
tasks:
  - title: only task
    deps: []
    tier: medium
    bundles: [sketch/feat-x]
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    plan_path = proj_b / "_plan.yaml"
    plan_path.write_text(yaml_text)

    r = _invoke(["scaffold", "--file", str(plan_path)])
    assert r.exit_code == 0, r.output
    epic_id = _parse_envelope(r.output)["epic_id"]

    epic_def = _read_json(proj_b / ".planctl" / "epics" / f"{epic_id}.json")
    assert epic_def["snippets"] == ["snip-a", "snip-b"]
    assert epic_def["bundles"] == []
    assert all(not b.startswith("sketch/") for b in epic_def["bundles"])

    task_def = _read_json(proj_b / ".planctl" / "tasks" / f"{epic_id}.1.json")
    assert task_def["snippets"] == ["snip-a", "snip-b"]
    assert task_def["bundles"] == []


@pytest.mark.real_sketch
def test_scaffold_sketch_in_foreign_project_unresolvable(two_projects):
    """Sketch in project A (not cwd) → ref_invalid; no writes land.

    This is the fn-608 failure mode rewritten as a write-time gate:
    anchoring on cwd (B) means an A-only sketch is unresolvable, and we
    fail loud at write rather than silently persisting a poisoned ref.
    """
    _root, proj_a, proj_b = two_projects
    _write_sketch(proj_a, "feat-y", ["a-only-snip"])

    yaml_text = f"""\
epic:
  title: foreign sketch
  bundles: [sketch/feat-y]
  spec: |
    ## Overview
    x.
tasks:
  - title: only task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    plan_path = proj_b / "_plan.yaml"
    plan_path.write_text(yaml_text)

    r = _invoke(["scaffold", "--file", str(plan_path)])
    assert r.exit_code != 0, r.output
    env = _parse_envelope(r.output)
    assert env["error"]["code"] == "ref_invalid"

    # No epic or task landed in either project.
    for proj in (proj_a, proj_b):
        epics_dir = proj / ".planctl" / "epics"
        tasks_dir = proj / ".planctl" / "tasks"
        assert not list(epics_dir.glob("fn-*.json"))
        assert not list(tasks_dir.glob("fn-*.json"))


def test_scaffold_empty_sketch_drops_ref_no_ids(two_projects):
    """Empty sketch in cwd project: ref dropped, snippets unchanged."""
    _root, _proj_a, proj_b = two_projects
    _write_sketch(proj_b, "empty-x", [])

    yaml_text = f"""\
epic:
  title: empty cwd sketch
  snippets: [stay-put]
  bundles: [sketch/empty-x]
  spec: |
    ## Overview
    x.
tasks:
  - title: only task
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    plan_path = proj_b / "_plan.yaml"
    plan_path.write_text(yaml_text)

    r = _invoke(["scaffold", "--file", str(plan_path)])
    assert r.exit_code == 0, r.output
    epic_id = _parse_envelope(r.output)["epic_id"]
    epic_def = _read_json(proj_b / ".planctl" / "epics" / f"{epic_id}.json")
    assert epic_def["snippets"] == ["stay-put"]
    assert epic_def["bundles"] == []


# ---------------------------------------------------------------------------
# refine-apply
# ---------------------------------------------------------------------------


def _seed_simple_epic(proj: Path) -> str:
    """Scaffold a tiny epic in *proj* and return its id."""
    yaml_text = f"""\
epic:
  title: seed for refine
  spec: |
    ## Overview
    x.
tasks:
  - title: bootstrap
    deps: []
    tier: medium
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    plan_path = proj / "_seed.yaml"
    plan_path.write_text(yaml_text)
    r = _invoke(["scaffold", "--file", str(plan_path)])
    assert r.exit_code == 0, r.output
    return _parse_envelope(r.output)["epic_id"]


@pytest.mark.real_sketch
def test_refine_apply_inlines_sketch_against_cwd(two_projects):
    """add_tasks entry's sketch ref folds into its persisted snippets."""
    _root, _proj_a, proj_b = two_projects
    epic_id = _seed_simple_epic(proj_b)
    _write_sketch(proj_b, "refine-x", ["r-snip-1", "r-snip-2"])

    delta = f"""\
add_tasks:
  - title: added with sketch
    deps: []
    tier: medium
    snippets: [pre]
    bundles: [sketch/refine-x, bundle/dev-env]
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    delta_path = proj_b / "_delta.yaml"
    delta_path.write_text(delta)

    r = _invoke(["refine-apply", epic_id, "--file", str(delta_path)])
    assert r.exit_code == 0, r.output
    new_task_id = _parse_envelope(r.output)["added_task_ids"][0]
    task_def = _read_json(proj_b / ".planctl" / "tasks" / f"{new_task_id}.json")
    assert task_def["snippets"] == ["pre", "r-snip-1", "r-snip-2"]
    assert task_def["bundles"] == ["bundle/dev-env"]
    assert all(not b.startswith("sketch/") for b in task_def["bundles"])


@pytest.mark.real_sketch
def test_refine_apply_unresolvable_sketch_fails_loud(two_projects):
    """Sketch in A only → ref_invalid; tree on disk unchanged."""
    _root, proj_a, proj_b = two_projects
    epic_id = _seed_simple_epic(proj_b)
    _write_sketch(proj_a, "ghost", ["unreachable"])
    pre_tasks = sorted((proj_b / ".planctl" / "tasks").glob("*.json"))

    delta = f"""\
add_tasks:
  - title: doomed
    deps: []
    tier: medium
    bundles: [sketch/ghost]
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    delta_path = proj_b / "_delta.yaml"
    delta_path.write_text(delta)

    r = _invoke(["refine-apply", epic_id, "--file", str(delta_path)])
    assert r.exit_code != 0, r.output
    env = _parse_envelope(r.output)
    assert env["error"]["code"] == "ref_invalid"

    # Pre-existing tasks still there, no new task landed.
    post_tasks = sorted((proj_b / ".planctl" / "tasks").glob("*.json"))
    assert post_tasks == pre_tasks


def test_refine_apply_empty_sketch_drops_ref(two_projects):
    """Empty sketch: ref drops, no new ids in snippets."""
    _root, _proj_a, proj_b = two_projects
    epic_id = _seed_simple_epic(proj_b)
    _write_sketch(proj_b, "blank", [])

    delta = f"""\
add_tasks:
  - title: blank sketch consumer
    deps: []
    tier: medium
    snippets: [keep]
    bundles: [sketch/blank]
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    delta_path = proj_b / "_delta.yaml"
    delta_path.write_text(delta)

    r = _invoke(["refine-apply", epic_id, "--file", str(delta_path)])
    assert r.exit_code == 0, r.output
    new_task_id = _parse_envelope(r.output)["added_task_ids"][0]
    task_def = _read_json(proj_b / ".planctl" / "tasks" / f"{new_task_id}.json")
    assert task_def["snippets"] == ["keep"]
    assert task_def["bundles"] == []


# ---------------------------------------------------------------------------
# epic set-bundles
# ---------------------------------------------------------------------------


@pytest.mark.real_sketch
def test_epic_set_bundles_inlines_sketch(two_projects):
    """Sketch in cwd project resolves; ids fold into epic.snippets."""
    _root, _proj_a, proj_b = two_projects
    epic_id = _seed_simple_epic(proj_b)
    _write_sketch(proj_b, "esb-x", ["e1", "e2"])

    r = _invoke(
        [
            "epic",
            "set-bundles",
            epic_id,
            "--bundles",
            "sketch/esb-x,bundle/dev-env",
        ]
    )
    assert r.exit_code == 0, r.output
    epic_def = _read_json(proj_b / ".planctl" / "epics" / f"{epic_id}.json")
    assert epic_def["bundles"] == ["bundle/dev-env"]
    # Sketch ids merged into snippets (the seed epic had none).
    assert epic_def["snippets"] == ["e1", "e2"]


@pytest.mark.real_sketch
def test_epic_set_bundles_missing_sketch_fails_no_write(two_projects):
    """Unresolvable sketch → non-zero exit; bundles unchanged on disk."""
    _root, _proj_a, proj_b = two_projects
    epic_id = _seed_simple_epic(proj_b)
    pre = _read_json(proj_b / ".planctl" / "epics" / f"{epic_id}.json")

    r = _invoke(["epic", "set-bundles", epic_id, "--bundles", "sketch/nope"])
    assert r.exit_code != 0, r.output

    post = _read_json(proj_b / ".planctl" / "epics" / f"{epic_id}.json")
    assert post["bundles"] == pre["bundles"]
    assert post["snippets"] == pre["snippets"]


def test_epic_set_bundles_empty_sketch_drops_ref(two_projects):
    """Empty sketch: ref dropped, no ids added."""
    _root, _proj_a, proj_b = two_projects
    epic_id = _seed_simple_epic(proj_b)
    _write_sketch(proj_b, "esb-empty", [])

    r = _invoke(
        [
            "epic",
            "set-bundles",
            epic_id,
            "--bundles",
            "sketch/esb-empty,bundle/snippeting-main",
        ]
    )
    assert r.exit_code == 0, r.output
    epic_def = _read_json(proj_b / ".planctl" / "epics" / f"{epic_id}.json")
    assert epic_def["bundles"] == ["bundle/snippeting-main"]
    assert epic_def["snippets"] == []


# ---------------------------------------------------------------------------
# task set-bundles
# ---------------------------------------------------------------------------


@pytest.mark.real_sketch
def test_task_set_bundles_inlines_sketch(two_projects):
    """Sketch resolves; ids fold into task.snippets; sketch dropped."""
    _root, _proj_a, proj_b = two_projects
    epic_id = _seed_simple_epic(proj_b)
    task_id = f"{epic_id}.1"
    _write_sketch(proj_b, "tsb-x", ["t1", "t2"])

    r = _invoke(
        [
            "task",
            "set-bundles",
            task_id,
            "--bundles",
            "sketch/tsb-x,bundle/dev-env",
        ]
    )
    assert r.exit_code == 0, r.output
    task_def = _read_json(proj_b / ".planctl" / "tasks" / f"{task_id}.json")
    assert task_def["bundles"] == ["bundle/dev-env"]
    assert task_def["snippets"] == ["t1", "t2"]


@pytest.mark.real_sketch
def test_task_set_bundles_missing_sketch_fails_no_write(two_projects):
    """Missing sketch → non-zero exit; on-disk task untouched."""
    _root, _proj_a, proj_b = two_projects
    epic_id = _seed_simple_epic(proj_b)
    task_id = f"{epic_id}.1"
    pre = _read_json(proj_b / ".planctl" / "tasks" / f"{task_id}.json")

    r = _invoke(["task", "set-bundles", task_id, "--bundles", "sketch/missing"])
    assert r.exit_code != 0, r.output

    post = _read_json(proj_b / ".planctl" / "tasks" / f"{task_id}.json")
    assert post["bundles"] == pre["bundles"]
    assert post["snippets"] == pre["snippets"]


def test_task_set_bundles_empty_sketch_drops_ref(two_projects):
    """Empty sketch: ref dropped, snippets unchanged."""
    _root, _proj_a, proj_b = two_projects
    epic_id = _seed_simple_epic(proj_b)
    task_id = f"{epic_id}.1"
    _write_sketch(proj_b, "tsb-empty", [])

    r = _invoke(
        [
            "task",
            "set-bundles",
            task_id,
            "--bundles",
            "sketch/tsb-empty,bundle/dev-env",
        ]
    )
    assert r.exit_code == 0, r.output
    task_def = _read_json(proj_b / ".planctl" / "tasks" / f"{task_id}.json")
    assert task_def["bundles"] == ["bundle/dev-env"]
    assert task_def["snippets"] == []


# ---------------------------------------------------------------------------
# fn-616 audit follow-ups: collect-all error aggregation + bypass invariant
# ---------------------------------------------------------------------------


@pytest.mark.real_sketch
def test_scaffold_collect_all_reports_every_bad_sketch_ref(two_projects):
    """Epic + multiple add_tasks all carrying bad sketch refs surface every
    offending ref in the error details list — not just the first.

    Locks the collect-all design at run_scaffold.py L533/L547: a regression
    to short-circuit-on-first-error would silently drop subsequent errors,
    forcing the author through a fix-rerun cycle per ref. The bar is the
    `sketch_errors` list-append pattern — all three refs land in one envelope.
    """
    _root, _proj_a, proj_b = two_projects
    # Three distinct unresolvable refs across epic + two tasks. None of the
    # sketches exist anywhere — the resolver fails per-entry, the verb
    # accumulates and emits a single ref_invalid envelope listing all three.
    yaml_text = f"""\
epic:
  title: collect-all bad sketches
  bundles: [sketch/missing-epic]
  spec: |
    ## Overview
    x.
tasks:
  - title: t1
    deps: []
    tier: medium
    bundles: [sketch/missing-t1]
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
  - title: t2
    deps: []
    tier: medium
    bundles: [sketch/missing-t2]
    spec: |
{_indent(_VALID_TASK_SPEC, 6)}
"""
    plan_path = proj_b / "_plan.yaml"
    plan_path.write_text(yaml_text)

    r = _invoke(["scaffold", "--file", str(plan_path)])
    assert r.exit_code != 0, r.output
    env = _parse_envelope(r.output)
    assert env["error"]["code"] == "ref_invalid"

    details = env["error"]["details"]
    assert isinstance(details, list)
    # All three offending refs should appear, attributable to their source.
    joined = "\n".join(details)
    assert "sketch/missing-epic" in joined, details
    assert "sketch/missing-t1" in joined, details
    assert "sketch/missing-t2" in joined, details
    # Source attribution: the epic ref carries "epic:" prefix, task refs
    # carry "task #N:" prefixes.
    assert any(d.startswith("epic:") for d in details), details
    assert any(d.startswith("task #1:") for d in details), details
    assert any(d.startswith("task #2:") for d in details), details


def test_refine_apply_rewrite_specs_only_bypass_drops_stray_sketch_ref(
    two_projects,
):
    """A rewrite_specs/rewire_deps-only delta carrying a stray `sketch/`
    ref in unsupported fields must NOT result in a `sketch/` ref reaching
    disk. Either the verb errors loud, or the persisted record stays clean.

    Locks the comment at run_refine_apply.py ~L520 against schema drift —
    today these paths don't accept bundles fields, so a stray ref is
    silently ignored at parse time and the existing record is preserved.
    A regression that started honoring bundles fields here (without
    routing them through `inline_sketch_refs`) would silently persist a
    sketch ref a worker on another machine cannot resolve.
    """
    _root, _proj_a, proj_b = two_projects
    epic_id = _seed_simple_epic(proj_b)
    task_id = f"{epic_id}.1"

    # Capture pre-state — rewrite_specs/rewire_deps must not perturb
    # snippets/bundles on the persisted task record.
    pre = _read_json(proj_b / ".planctl" / "tasks" / f"{task_id}.json")
    assert pre["bundles"] == []
    assert pre["snippets"] == []

    # Build a rewrite_specs-only delta where each entry smuggles a stray
    # `sketch/` ref via a bundles field rewrite_specs is not supposed to
    # accept. Also add a rewire_deps entry doing the same. Neither key
    # routes through `inline_sketch_refs`; the bypass invariant is that
    # the on-disk record never grows a sketch/ ref.
    new_spec = _VALID_TASK_SPEC.replace("Implement the thing.", "Updated body.")
    delta = f"""\
rewrite_specs:
  - task_id: {task_id}
    bundles: [sketch/stray-rewrite]
    spec: |
{_indent(new_spec, 6)}
rewire_deps:
  - task_id: {task_id}
    bundles: [sketch/stray-rewire]
    deps: []
"""
    delta_path = proj_b / "_delta.yaml"
    delta_path.write_text(delta)

    r = _invoke(["refine-apply", epic_id, "--file", str(delta_path)])

    # Acceptance offers two valid outcomes: (a) the verb errors, OR
    # (b) the persisted record carries no `sketch/` refs.
    post = _read_json(proj_b / ".planctl" / "tasks" / f"{task_id}.json")
    assert all(not b.startswith("sketch/") for b in post.get("bundles", [])), post
    assert all(not s.startswith("sketch/") for s in post.get("snippets", [])), post
    # On success, bundles/snippets stayed unperturbed (the keys were
    # silently ignored at parse time, as the L520 comment promises).
    if r.exit_code == 0:
        assert post["bundles"] == pre["bundles"]
        assert post["snippets"] == pre["snippets"]
