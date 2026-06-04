"""Tests for ``planctl.integrity`` and ``planctl.run_validate`` (fn-587 task .3).

Mutating verbs resolve the session id from CLAUDE_CODE_SESSION_ID; these
tests set it explicitly.

The structural-integrity check used to live inline in ``run_validate.py``'s
``--epic`` block — task .3 factored it out into a shared helper so scaffold
can run the same check before stamping ``last_validated_at`` on a fresh epic.

Coverage:

- Pure-helper behaviour (``validate_epic_integrity`` / ``check_epic_tree_in_memory``):
  - Valid epic + task tree returns an empty error list.
  - Cycle is caught.
  - Missing task spec headings caught.
  - Non-``.git/`` ``primary_repo`` caught.
- Wiring: ``run_validate.py``'s ``--epic`` block delegates to the shared
  helper (mock-and-trace), preserving the envelope shape and exit codes the
  legacy block produced.

The broader marker-write / clear-on-mutation behaviour is exercised in
``test_validate_marker.py`` and stays unchanged.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from unittest.mock import patch

from click.testing import CliRunner  # type: ignore[import-untyped]
from planctl.cli import cli
from planctl.integrity import (
    _check_epic_tree,
    check_epic_tree_in_memory,
    validate_epic_integrity,
    validate_epic_integrity_with_warnings,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


_VALID_TASK_SPEC = (
    "## Description\n\n## Acceptance\n- [ ] x\n\n## Done summary\n\n## Evidence\n"
)


def _seed(tmp_path, monkeypatch) -> tuple[Path, str, str]:
    """Scaffold a one-task epic in tmp_path; return (project_path, epic_id, task_id)."""
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-validate-fixture")
    monkeypatch.chdir(tmp_path)
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test User"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "config", "commit.gpgsign", "false"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "config", "core.hooksPath", "/dev/null"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
    )
    readme = tmp_path / "README.md"
    readme.write_text("# test\n")
    subprocess.run(
        ["git", "add", "README.md"], cwd=tmp_path, check=True, capture_output=True
    )
    subprocess.run(
        ["git", "commit", "-m", "init"], cwd=tmp_path, check=True, capture_output=True
    )

    runner = CliRunner()
    result = runner.invoke(cli, ["init"])
    assert result.exit_code == 0, result.output
    subprocess.run(
        ["git", "add", ".planctl/"], cwd=tmp_path, check=True, capture_output=True
    )
    subprocess.run(
        ["git", "commit", "-m", "planctl init"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
    )

    spec_block = "\n".join("      " + ln for ln in _VALID_TASK_SPEC.splitlines())
    plan = (
        "epic:\n"
        "  title: integrity helper test\n"
        "  spec: |\n"
        "    ## Overview\n"
        "    x.\n"
        "tasks:\n"
        "  - title: only task\n"
        "    deps: []\n"
        "    tier: medium\n"
        f"    spec: |\n{spec_block}\n"
    )
    plan_path = tmp_path / "plan.yaml"
    plan_path.write_text(plan)
    result = runner.invoke(cli, ["scaffold", "--file", str(plan_path)])
    assert result.exit_code == 0, result.output

    # Mutating verbs emit a single compact NDJSON line — find the {success:true} line.
    payload = None
    for line in result.output.strip().splitlines():
        line = line.strip()
        if line.startswith("{") and '"success"' in line:
            payload = json.loads(line)
            break
    assert payload is not None, result.output
    return tmp_path, payload["epic_id"], payload["task_ids"][0]


# ---------------------------------------------------------------------------
# Pure-helper behaviour
# ---------------------------------------------------------------------------


def test_validate_epic_integrity_valid_tree_returns_empty(tmp_path, monkeypatch):
    """A scaffold-produced epic must pass the shared integrity check
    immediately — same shape used by ``run_validate.py:--epic``."""
    project_path, epic_id, _task_id = _seed(tmp_path, monkeypatch)
    data_dir = project_path / ".planctl"

    errors = validate_epic_integrity(epic_id, data_dir)
    assert errors == [], errors


def test_validate_epic_integrity_with_warnings_returns_tuple(tmp_path, monkeypatch):
    """``validate_epic_integrity_with_warnings`` returns ``(errors, warnings)``;
    a valid scaffold tree has both lists empty (no touched_repos drift)."""
    project_path, epic_id, _task_id = _seed(tmp_path, monkeypatch)
    data_dir = project_path / ".planctl"

    errors, warnings = validate_epic_integrity_with_warnings(epic_id, data_dir)
    assert errors == [], errors
    assert warnings == [], warnings


def test_check_epic_tree_in_memory_catches_cycle(tmp_path):
    """Pure-fn cycle detection on the in-memory task graph fires under
    ``check_epic_tree_in_memory``."""
    data_dir = tmp_path / ".planctl"
    (data_dir / "specs").mkdir(parents=True)
    # Epic spec file is required by the integrity check.
    (data_dir / "specs" / "fn-1-foo.md").write_text("## Overview\nfoo.\n")

    epic = {
        "id": "fn-1-foo",
        "title": "foo",
        "status": "open",
        "primary_repo": None,
        "touched_repos": None,
    }
    task_a = {
        "id": "fn-1-foo.1",
        "epic": "fn-1-foo",
        "title": "a",
        "depends_on": ["fn-1-foo.2"],
    }
    task_b = {
        "id": "fn-1-foo.2",
        "epic": "fn-1-foo",
        "title": "b",
        "depends_on": ["fn-1-foo.1"],
    }
    errors, _warnings = check_epic_tree_in_memory(
        "fn-1-foo",
        epic,
        {"fn-1-foo.1": task_a, "fn-1-foo.2": task_b},
        {"fn-1-foo.1": _VALID_TASK_SPEC, "fn-1-foo.2": _VALID_TASK_SPEC},
        data_dir=data_dir,
        all_epic_ids={"fn-1-foo"},
    )
    assert any("cycle detected" in e for e in errors), errors


def test_check_epic_tree_in_memory_catches_missing_heading(tmp_path):
    """A task spec missing a required heading triggers the
    ``validate_task_spec_headings`` path inside the in-memory check."""
    data_dir = tmp_path / ".planctl"
    (data_dir / "specs").mkdir(parents=True)
    (data_dir / "specs" / "fn-2-bar.md").write_text("## Overview\nbar.\n")

    epic = {
        "id": "fn-2-bar",
        "title": "bar",
        "status": "open",
        "primary_repo": None,
        "touched_repos": None,
    }
    task = {
        "id": "fn-2-bar.1",
        "epic": "fn-2-bar",
        "title": "t",
        "depends_on": [],
    }
    # Missing the four required headings — only Description present.
    bad_spec = "## Description\n\n"
    errors, _warnings = check_epic_tree_in_memory(
        "fn-2-bar",
        epic,
        {"fn-2-bar.1": task},
        {"fn-2-bar.1": bad_spec},
        data_dir=data_dir,
        all_epic_ids={"fn-2-bar"},
    )
    assert any("Missing required heading" in e for e in errors), errors


def test_check_epic_tree_in_memory_catches_non_git_primary_repo(tmp_path):
    """A primary_repo path that exists but lacks ``.git/`` is rejected when
    the caller opts into filesystem checks.  Scaffold's default
    (``check_filesystem_repos=False``) skips this branch because epic JSON is
    designed to ship cross-machine; ``validate --epic`` opts in via the
    public ``validate_epic_integrity*`` surface."""
    data_dir = tmp_path / ".planctl"
    (data_dir / "specs").mkdir(parents=True)
    (data_dir / "specs" / "fn-3-baz.md").write_text("## Overview\nbaz.\n")

    bogus = tmp_path / "no-dot-git"
    bogus.mkdir()

    epic = {
        "id": "fn-3-baz",
        "title": "baz",
        "status": "open",
        "primary_repo": str(bogus),
        "touched_repos": [str(bogus)],
    }
    errors, _warnings = check_epic_tree_in_memory(
        "fn-3-baz",
        epic,
        {},
        {},
        data_dir=data_dir,
        all_epic_ids={"fn-3-baz"},
        check_filesystem_repos=True,
    )
    assert any("no .git/" in e for e in errors), errors

    # And confirm scaffold's default (no filesystem check) leaves the field
    # alone.
    errors_no_fs, _w = check_epic_tree_in_memory(
        "fn-3-baz",
        epic,
        {},
        {},
        data_dir=data_dir,
        all_epic_ids={"fn-3-baz"},
    )
    assert not any("no .git/" in e for e in errors_no_fs), errors_no_fs


def test_check_epic_tree_in_memory_emits_touched_repos_warning(tmp_path):
    """A task ``target_repo`` not in ``epic.touched_repos`` surfaces as a
    *warning* (not an error) — same behaviour as the legacy run_validate
    block."""
    data_dir = tmp_path / ".planctl"
    (data_dir / "specs").mkdir(parents=True)
    (data_dir / "specs" / "fn-4-quux.md").write_text("## Overview\nq.\n")

    real_repo = tmp_path / "real"
    real_repo.mkdir()
    subprocess.run(["git", "init"], cwd=str(real_repo), check=True, capture_output=True)
    drift_repo = tmp_path / "drift"
    drift_repo.mkdir()
    subprocess.run(
        ["git", "init"], cwd=str(drift_repo), check=True, capture_output=True
    )

    epic = {
        "id": "fn-4-quux",
        "title": "q",
        "status": "open",
        # primary_repo None to skip the samefile check (data_dir.parent is
        # tmp_path, not a real git repo for this minimal fixture).
        "primary_repo": None,
        "touched_repos": [str(real_repo)],
    }
    task = {
        "id": "fn-4-quux.1",
        "epic": "fn-4-quux",
        "title": "t",
        "depends_on": [],
        "target_repo": str(drift_repo),  # not in touched_repos
    }
    errors, warnings = check_epic_tree_in_memory(
        "fn-4-quux",
        epic,
        {"fn-4-quux.1": task},
        {"fn-4-quux.1": _VALID_TASK_SPEC},
        data_dir=data_dir,
        all_epic_ids={"fn-4-quux"},
    )
    assert errors == [], errors
    assert any("not in epic.touched_repos" in w for w in warnings), warnings


# ---------------------------------------------------------------------------
# Wiring: run_validate.py:--epic delegates to the shared helper.
# ---------------------------------------------------------------------------


def test_run_validate_calls_shared_integrity_helper(tmp_path, monkeypatch):
    """``run_validate.py:--epic`` must route through
    ``validate_epic_integrity_with_warnings`` — patch the helper at its source
    module and confirm it gets the freshly-scaffolded epic_id as its first arg.

    ``run_validate.py`` does its imports inside the ``run`` function (cli
    bootstrap hot-path), so the patched name has to live on
    ``planctl.integrity`` where the import resolves to.
    """
    project_path, epic_id, _task_id = _seed(tmp_path, monkeypatch)

    calls: list[tuple] = []

    def _spy(eid, data_dir):
        calls.append((eid, data_dir))
        # Return shape matches the helper's contract: (errors, warnings).
        return ([], [])

    with patch(
        "planctl.integrity.validate_epic_integrity_with_warnings", side_effect=_spy
    ):
        runner = CliRunner()
        result = runner.invoke(cli, ["validate", "--epic", epic_id])

    assert result.exit_code == 0, result.output
    # Must have been called exactly once with the scaffolded epic id.
    assert len(calls) == 1, calls
    called_eid, called_data_dir = calls[0]
    assert called_eid == epic_id
    assert called_data_dir == project_path / ".planctl"


def test_run_validate_no_epic_still_iterates_through_helper(tmp_path, monkeypatch):
    """Validate without ``--epic`` walks every epic on disk; each gets one
    call to the shared helper."""
    project_path, epic_id, _task_id = _seed(tmp_path, monkeypatch)

    calls: list[str] = []

    def _spy(eid, _data_dir):
        calls.append(eid)
        return ([], [])

    with patch(
        "planctl.integrity.validate_epic_integrity_with_warnings", side_effect=_spy
    ):
        runner = CliRunner()
        result = runner.invoke(cli, ["validate"])

    assert result.exit_code == 0, result.output
    # The scaffolded epic_id appears in the call list — there's only one epic
    # on disk in this fixture so exactly one call lands.
    assert calls == [epic_id], calls


def test_check_epic_tree_pure_fn_signature(tmp_path):
    """``_check_epic_tree`` is a pure function over its arguments — no IO
    beyond ``data_dir / specs / <eid>.md`` existence (epic spec file).  This
    test pins the signature so accidental drift in argument order shows up.
    """
    import inspect

    sig = inspect.signature(_check_epic_tree)
    assert list(sig.parameters)[:4] == [
        "eid",
        "epic_data",
        "task_defs",
        "task_spec_contents",
    ], sig


# ---------------------------------------------------------------------------
# fn-588 task .1: epic-dep cycle detection across the project-wide graph.
# ---------------------------------------------------------------------------


def _seed_epic_files_for_dep_cycle(tmp_path) -> Path:
    """Materialise two epic spec files (A and B) so the integrity check's
    epic-spec-file existence test passes for both."""
    data_dir = tmp_path / ".planctl"
    specs_dir = data_dir / "specs"
    specs_dir.mkdir(parents=True)
    (specs_dir / "fn-100-aaa.md").write_text("## Overview\na.\n")
    (specs_dir / "fn-101-bbb.md").write_text("## Overview\nb.\n")
    return data_dir


def test_check_epic_tree_in_memory_catches_epic_dep_cycle(tmp_path):
    """A fresh A -> B -> A epic-dep cycle is reported as an integrity error
    when ``all_epic_deps`` is provided to ``check_epic_tree_in_memory``."""
    data_dir = _seed_epic_files_for_dep_cycle(tmp_path)

    epic_a = {
        "id": "fn-100-aaa",
        "title": "a",
        "status": "open",
        "depends_on_epics": ["fn-101-bbb"],
        "primary_repo": None,
        "touched_repos": None,
    }

    errors, _warnings = check_epic_tree_in_memory(
        "fn-100-aaa",
        epic_a,
        {},
        {},
        data_dir=data_dir,
        all_epic_ids={"fn-100-aaa", "fn-101-bbb"},
        all_epic_deps={
            "fn-100-aaa": ["fn-101-bbb"],
            "fn-101-bbb": ["fn-100-aaa"],
        },
    )
    assert any("epic-dep cycle detected" in e for e in errors), errors


def test_check_epic_tree_in_memory_skips_epic_dep_cycle_without_map(tmp_path):
    """Without ``all_epic_deps`` the epic-dep cycle check is skipped — the
    legacy caller contract (no full epic-universe loaded) keeps working."""
    data_dir = _seed_epic_files_for_dep_cycle(tmp_path)

    epic_a = {
        "id": "fn-100-aaa",
        "title": "a",
        "status": "open",
        "depends_on_epics": ["fn-101-bbb"],
        "primary_repo": None,
        "touched_repos": None,
    }
    errors, _warnings = check_epic_tree_in_memory(
        "fn-100-aaa",
        epic_a,
        {},
        {},
        data_dir=data_dir,
        all_epic_ids={"fn-100-aaa", "fn-101-bbb"},
    )
    assert not any("epic-dep cycle detected" in e for e in errors), errors


def test_validate_epic_integrity_with_warnings_catches_epic_dep_cycle(
    tmp_path, monkeypatch
):
    """A fresh A -> B -> A cycle materialised on disk is reported by the
    on-disk path (``validate_epic_integrity_with_warnings``) — the same path
    that the ``add-dep`` / ``add-deps`` post-write restamp gate routes through
    via ``_check_epic_tree``.

    Builds two minimal epic JSON files directly on disk (no scaffold) so the
    test focuses on the integrity check itself.  The on-disk path glob-loads
    every epic's ``depends_on_epics`` and runs the cycle walk.
    """
    monkeypatch.chdir(tmp_path)
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)

    data_dir = tmp_path / ".planctl"
    epics_dir = data_dir / "epics"
    specs_dir = data_dir / "specs"
    epics_dir.mkdir(parents=True)
    specs_dir.mkdir(parents=True)

    (specs_dir / "fn-100-aaa.md").write_text("## Overview\na.\n")
    (specs_dir / "fn-101-bbb.md").write_text("## Overview\nb.\n")

    def _epic_json(eid: str, deps: list[str]) -> dict:
        return {
            "id": eid,
            "title": eid,
            "status": "open",
            "depends_on_epics": deps,
            "primary_repo": None,
            "touched_repos": None,
            "last_validated_at": None,
        }

    (epics_dir / "fn-100-aaa.json").write_text(
        json.dumps(_epic_json("fn-100-aaa", ["fn-101-bbb"]))
    )
    (epics_dir / "fn-101-bbb.json").write_text(
        json.dumps(_epic_json("fn-101-bbb", ["fn-100-aaa"]))
    )

    errors, _warnings = validate_epic_integrity_with_warnings("fn-100-aaa", data_dir)
    assert any("epic-dep cycle detected" in e for e in errors), errors
