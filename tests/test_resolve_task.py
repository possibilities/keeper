"""Tests for planctl resolve-task — read-only routing lookup (fn-593 task .1).

Cases:
- Happy path: tier set, full envelope returned with all routing fields.
- Null-tier path: tier surfaces as JSON null on a fresh (un-tiered) task.
- Bad input: BAD_TASK_ID on a malformed id.
- Missing: TASK_NOT_FOUND on a well-formed but unknown id.
- Ambiguous: AMBIGUOUS_TASK_ID when the same id exists in two projects.
- --project disambiguation: collision resolves cleanly when --project is given.
- NOT_A_PROJECT: --project pointing at a non-planctl dir.
- Read-only contract: no chore(planctl): commit after a successful call.
- Envelope shape: target_repo / primary_repo are absolute paths;
  planctl_invocation carries op=resolve-task with NULL files/subject.
"""

from __future__ import annotations

import contextlib
import json
import subprocess

import pytest
from click.testing import CliRunner
from planctl.cli import cli

# resolve-task is read-only and spawns no real git, but every test drives roots
# discovery against the ``_roots_at_tmp_project`` CONFIG_PATH below. That tmp
# root must win over the autouse ``_isolated_roots_default`` (which forces empty
# discovery) — ``real_roots`` opts out onto the controlled tmp root, never the
# real ~/code. Fast-path marker (NOT slow bucket): the fast gate runs these.
pytestmark = pytest.mark.real_roots


@pytest.fixture(autouse=True)
def _roots_at_tmp_project(tmp_path, monkeypatch):
    """Point planctl roots discovery at an isolated root holding only ``tmp_path``.

    Same shape as ``tests/test_claim.py::_roots_at_tmp_project`` — without
    this autouse fixture, discovery scans the real ``~/code`` default and
    can't find the seeded ``fn-N`` task → spurious TASK_NOT_FOUND. Ambiguity
    tests override CONFIG_PATH themselves; the later ``setattr`` wins.
    """
    root = tmp_path / "_resolve_root"
    root.mkdir()
    (root / tmp_path.name).symlink_to(tmp_path, target_is_directory=True)
    cfg = tmp_path / "_resolve_roots_config.yaml"
    cfg.write_text(f"roots:\n  - {root}\n", encoding="utf-8")
    monkeypatch.setattr("planctl.config.CONFIG_PATH", cfg)


def _invoke(args: list[str]) -> tuple[int, dict | None, str]:
    runner = CliRunner()
    result = runner.invoke(cli, args)
    obj = _first_envelope(result.output)
    return result.exit_code, obj, result.output


def _first_envelope(output: str) -> dict | None:
    """Return the first JSON object in *output* that is NOT a planctl_invocation
    envelope. Tolerates both compact one-line and pretty-printed multi-line JSON."""
    decoder = json.JSONDecoder()
    text = output
    i = 0
    while i < len(text):
        if text[i] == "{":
            with contextlib.suppress(json.JSONDecodeError):
                obj, end = decoder.raw_decode(text[i:])
                if (
                    isinstance(obj, dict)
                    and "planctl_invocation" in obj
                    and len(obj) == 1
                ):
                    i += end
                    continue
                return obj
        i += 1
    return None


def _make_epic_with_task():
    from pathlib import Path

    from .conftest import seed_epic

    epic_id, task_ids = seed_epic(Path.cwd(), title="Resolve epic", n_tasks=1)
    return epic_id, task_ids[0]


# ---------------------------------------------------------------------------
# Happy path: tier set, full envelope returned
# ---------------------------------------------------------------------------


def test_resolve_task_happy_path_with_tier(project):
    """resolve-task returns the full routing envelope on a known, tier-set task."""
    epic_id, task_id = _make_epic_with_task()

    code, _, output = _invoke(["task", "set-tier", task_id, "--tier", "high"])
    assert code == 0, output

    code, obj, output = _invoke(["resolve-task", task_id])
    assert code == 0, f"resolve-task failed:\n{output}"
    assert obj is not None
    assert obj.get("success") is True
    assert obj.get("task_id") == task_id
    assert obj.get("epic_id") == epic_id
    assert obj.get("tier") == "high"
    assert obj.get("worker_agent") == "plan:worker-high"
    assert obj.get("status") in {"todo", "in_progress"}
    # target_repo / primary_repo / project_path are absolute paths.
    assert obj.get("target_repo", "").startswith("/")
    assert obj.get("primary_repo", "").startswith("/")
    assert obj.get("project_path", "").startswith("/")


def test_resolve_task_tier_in_vocab(project):
    """The returned `tier` is one of medium|high|xhigh|max|null."""
    from planctl.models import TASK_TIERS

    _, task_id = _make_epic_with_task()
    code, _, output = _invoke(["task", "set-tier", task_id, "--tier", "xhigh"])
    assert code == 0, output

    code, obj, _ = _invoke(["resolve-task", task_id])
    assert code == 0
    assert obj is not None
    assert obj.get("tier") in tuple(TASK_TIERS) + (None,)


# ---------------------------------------------------------------------------
# Null-tier path: tier surfaces as explicit JSON null
# ---------------------------------------------------------------------------


def test_resolve_task_null_tier(project):
    """A pre-fn-594 legacy task with persisted tier=null surfaces as JSON null
    (not omitted) so the launcher / skill consumer can branch on it.

    fn-594: scaffold now requires tier at mint time so fresh tasks ship with
    a concrete value. Hand-null the persisted task_def to simulate a legacy
    on-disk record and verify resolve-task still surfaces the null cleanly.
    """
    _, task_id = _make_epic_with_task()

    # Hand-null to simulate a pre-fn-594 legacy on-disk record.
    task_path = project / ".planctl" / "tasks" / f"{task_id}.json"
    task_def = json.loads(task_path.read_text(encoding="utf-8"))
    task_def["tier"] = None
    task_path.write_text(json.dumps(task_def), encoding="utf-8")

    code, obj, output = _invoke(["resolve-task", task_id])
    assert code == 0, output
    assert obj is not None
    assert "tier" in obj, "tier key must be present even when null"
    assert obj["tier"] is None, (
        "legacy null-tier task should report tier=null so a consumer "
        "branches on 'tier is None' rather than treating absence as a default"
    )
    assert obj.get("worker_agent") is None, (
        "null-tier task must report worker_agent=null, not plan:worker-None"
    )


# ---------------------------------------------------------------------------
# Bad task id
# ---------------------------------------------------------------------------


def test_resolve_task_bad_id(project):
    """A malformed task id returns BAD_TASK_ID, exit 1."""
    code, obj, output = _invoke(["resolve-task", "not-a-task-id"])
    assert code != 0, output
    assert obj is not None
    assert obj.get("success") is False
    assert obj.get("error", {}).get("code") == "BAD_TASK_ID"


# ---------------------------------------------------------------------------
# Task not found
# ---------------------------------------------------------------------------


def test_resolve_task_not_found(project):
    """A well-formed id with no matching project returns TASK_NOT_FOUND."""
    code, obj, output = _invoke(["resolve-task", "fn-9999-no-task.1"])
    assert code != 0, output
    assert obj is not None
    assert obj.get("success") is False
    assert obj.get("error", {}).get("code") == "TASK_NOT_FOUND"


# ---------------------------------------------------------------------------
# Ambiguous task id across two projects
# ---------------------------------------------------------------------------


def _make_two_projects_with_same_task(tmp_path, monkeypatch):
    """Seed two sibling projects under a shared root, both holding the same task id.

    Overrides the autouse CONFIG_PATH to point at the two-project root so
    discovery surfaces both as candidates.
    """
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-session-fixture")
    root = tmp_path / "_ambiguous_root"
    root.mkdir()

    proj_a = root / "proj-a"
    proj_a.mkdir()
    proj_b = root / "proj-b"
    proj_b.mkdir()

    for proj in (proj_a, proj_b):
        subprocess.run(["git", "init"], cwd=proj, check=True, capture_output=True)
        # Committer identity / gpgsign / hooksPath ride GIT_CONFIG_GLOBAL (set by
        # the session-scoped _git_global_config fixture) — no per-repo config.
        # Initial commit so HEAD exists for the no-commit assertion later.
        (proj / "README.md").write_text("# Test repo\n")
        subprocess.run(
            ["git", "add", "README.md"], cwd=proj, check=True, capture_output=True
        )
        subprocess.run(
            ["git", "commit", "-m", "chore: initial commit"],
            cwd=proj,
            check=True,
            capture_output=True,
        )
        monkeypatch.chdir(proj)
        runner = CliRunner()
        result = runner.invoke(cli, ["init"])
        assert result.exit_code == 0, result.output

    from .conftest import seed_epic

    monkeypatch.chdir(proj_a)
    _, task_ids_a = seed_epic(proj_a, title="A", n_tasks=1)
    task_id = task_ids_a[0]
    epic_id = task_id.rsplit(".", 1)[0]

    # Duplicate A's task + epic JSON into B so the same task id resolves in both.
    import shutil

    (proj_b / ".planctl" / "tasks").mkdir(parents=True, exist_ok=True)
    (proj_b / ".planctl" / "epics").mkdir(parents=True, exist_ok=True)
    shutil.copy(
        proj_a / ".planctl" / "tasks" / f"{task_id}.json",
        proj_b / ".planctl" / "tasks" / f"{task_id}.json",
    )
    shutil.copy(
        proj_a / ".planctl" / "epics" / f"{epic_id}.json",
        proj_b / ".planctl" / "epics" / f"{epic_id}.json",
    )

    # Point CONFIG_PATH at this root, overriding the autouse fixture.
    cfg = tmp_path / "_ambiguous_roots_config.yaml"
    cfg.write_text(f"roots:\n  - {root}\n", encoding="utf-8")
    monkeypatch.setattr("planctl.config.CONFIG_PATH", cfg)

    return proj_a, proj_b, task_id


def test_resolve_task_ambiguous(tmp_path, monkeypatch):
    """Same task id in two projects under the configured roots → AMBIGUOUS_TASK_ID."""
    proj_a, proj_b, task_id = _make_two_projects_with_same_task(tmp_path, monkeypatch)

    code, obj, output = _invoke(["resolve-task", task_id])
    assert code != 0, output
    assert obj is not None
    assert obj.get("success") is False
    assert obj.get("error", {}).get("code") == "AMBIGUOUS_TASK_ID"
    candidates = obj["error"].get("details", {}).get("candidates", [])
    assert len(candidates) == 2
    assert str(proj_a) in candidates
    assert str(proj_b) in candidates


def test_resolve_task_project_disambiguates(tmp_path, monkeypatch):
    """--project <path> bypasses discovery and resolves cleanly across a collision."""
    proj_a, proj_b, task_id = _make_two_projects_with_same_task(tmp_path, monkeypatch)

    code, obj, output = _invoke(["resolve-task", task_id, "--project", str(proj_a)])
    assert code == 0, output
    assert obj is not None
    assert obj.get("project_path") == str(proj_a)

    code, obj, output = _invoke(["resolve-task", task_id, "--project", str(proj_b)])
    assert code == 0, output
    assert obj is not None
    assert obj.get("project_path") == str(proj_b)


def test_resolve_task_project_not_a_project(project, tmp_path):
    """--project <path> with no .planctl/ returns NOT_A_PROJECT."""
    not_a_proj = tmp_path / "not-a-planctl-proj"
    not_a_proj.mkdir()

    code, obj, output = _invoke(
        ["resolve-task", "fn-1-foo.1", "--project", str(not_a_proj)]
    )
    assert code != 0, output
    assert obj is not None
    assert obj.get("error", {}).get("code") == "NOT_A_PROJECT"


# ---------------------------------------------------------------------------
# Read-only contract: no chore(planctl): commit lands
# ---------------------------------------------------------------------------


@pytest.mark.real_git
def test_resolve_task_lands_no_commit(planctl_git_repo):
    """resolve-task is read-only — no `chore(planctl): resolve-task` commit lands.

    Asserts against a real HEAD / ``git log`` (no commit subject lands), so it
    needs the real ``planctl_git_repo`` history — ``real_git`` (slow bucket).
    """
    _, task_id = _make_epic_with_task()

    head_before = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=planctl_git_repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()

    code, obj, output = _invoke(["resolve-task", task_id])
    assert code == 0, output
    assert obj is not None

    head_after = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=planctl_git_repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()

    assert head_before == head_after, (
        "resolve-task is read-only; a chore(planctl): commit should not land"
    )

    log = subprocess.run(
        ["git", "log", "-5", "--pretty=%s"],
        cwd=planctl_git_repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    assert "resolve-task" not in log, (
        f"Found a resolve-task commit subject in recent history:\n{log}"
    )


# ---------------------------------------------------------------------------
# Envelope carries readonly planctl_invocation footer
# ---------------------------------------------------------------------------


def test_resolve_task_envelope_carries_readonly_invocation(project):
    """The envelope's planctl_invocation has op=resolve-task and NULL files/subject."""
    _, task_id = _make_epic_with_task()

    runner = CliRunner()
    result = runner.invoke(cli, ["resolve-task", task_id])
    assert result.exit_code == 0
    assert "resolve-task" in result.output

    decoder = json.JSONDecoder()
    i = 0
    text = result.output
    invocation_obj = None
    while i < len(text):
        if text[i] == "{":
            try:
                obj, end = decoder.raw_decode(text[i:])
                if isinstance(obj, dict) and "planctl_invocation" in obj:
                    invocation_obj = obj["planctl_invocation"]
                    break
                i += end
                continue
            except json.JSONDecodeError:
                pass
        i += 1
    assert invocation_obj is not None, (
        f"no planctl_invocation envelope in output:\n{result.output}"
    )
    assert invocation_obj.get("op") == "resolve-task"
    assert invocation_obj.get("subject") is None
    assert invocation_obj.get("files") is None
