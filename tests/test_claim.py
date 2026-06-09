"""Tests for ``planctl claim`` (fn-542 task .2; brief-file handoff fn-5 task .1).

Locks the enriched claim verb: typed error envelopes for every precondition,
the brief-handle happy-path envelope (``brief_ref``, no inline prose), CAS
outcomes (CLAIMED / ALREADY_MINE / CLAIMED_BY_OTHER), ``--force`` takeover
(never over TASK_DONE), the out-of-band brief write + SNIPPET_RENDER_FAILED,
and the no-audit-row-on-failure invariant.

Strategy: drive the real verb in-process via CliRunner against the
``planctl_git_repo`` fixture (git init + planctl init, chdir'd). ``PLANCTL_ACTOR``
env var pins identity so multi-actor CAS outcomes are deterministic. The
``render-spec`` shell-out resolves to an empty render (the seeded tasks carry
no snippets) → the on-disk brief's ``snippet_context == ""`` on the happy path;
SNIPPET_RENDER_FAILED is exercised by monkeypatching ``planctl.brief``'s
subprocess to return a non-zero exit.
"""

from __future__ import annotations

import json
import os
import subprocess

import pytest
from click.testing import CliRunner
from planctl.cli import cli


@pytest.fixture(autouse=True)
def _roots_at_tmp_project(tmp_path, monkeypatch):
    """Point planctl roots discovery at an isolated root holding only ``tmp_path``.

    Claim is cwd-agnostic (fn-542 task .3): it resolves the owning project via
    ``roots`` discovery, not the cwd. The ``planctl_git_repo`` / ``tmp_path``
    project must therefore be discoverable as an immediate child of a configured
    root. We can't relocate that project, so the root is a fresh per-test dir
    holding a single symlink (named after ``tmp_path``) back to the project.
    Using ``tmp_path.parent`` directly would surface every OTHER test's temp
    project as a sibling — and global epic numbering hands them all ``fn-1``,
    producing spurious AMBIGUOUS_TASK_ID collisions. The symlinked-isolated root
    sidesteps that. Without any config, discovery would scan the real ``~/code``
    default and never find the seeded ``fn-N`` task (→ spurious TASK_NOT_FOUND).

    Tests that build their own multi-project roots override ``CONFIG_PATH``
    again; the later ``monkeypatch.setattr`` wins.
    """
    root = tmp_path / "_claim_root"
    root.mkdir()
    (root / tmp_path.name).symlink_to(tmp_path, target_is_directory=True)
    cfg = tmp_path / "_claim_roots_config.yaml"
    cfg.write_text(f"roots:\n  - {root}\n", encoding="utf-8")
    monkeypatch.setattr("planctl.config.CONFIG_PATH", cfg)


def _invoke(args: list[str], env: dict | None = None):
    runner = CliRunner()
    if env:
        full_env = {**os.environ, **env}
        return runner.invoke(cli, args, env=full_env)
    return runner.invoke(cli, args)


def _first_line_json(output: str) -> dict:
    """Parse the primary envelope from CLI output.

    Success path (``emit(planctl_invocation=...)``) writes one compact NDJSON
    line — the first JSON line is the full envelope. Error path
    (``_emit_claim_error`` → ``format_output``) writes a pretty-printed
    multi-line JSON object with no trailing invocation line.

    Non-JSON preamble (e.g. ``planctl.audit: emit failed: [Errno 61] ...``
    when the jobctl UDS server is down) is skipped: scan for the first line
    that parses as a JSON object; on miss, parse the whole (stripped) output
    minus any leading non-JSON lines.
    """
    text = output.strip()
    lines = text.splitlines()
    # Try each line as compact JSON (the success NDJSON path).
    for line in lines:
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                pass
    # Fall back: strip leading non-JSON preamble, then parse the remainder as
    # one pretty-printed JSON object (the error path).
    start = next((i for i, ln in enumerate(lines) if ln.strip().startswith("{")), 0)
    return json.loads("\n".join(lines[start:]))


def _make_epic_with_task(actor: str = "alice@example.com") -> tuple[str, str]:
    """Scaffold an epic + task, return (epic_id, task_id).

    fn-565: minted via `scaffold` (the incremental `task create` verb is gone).
    The CliRunner cwd is the active project (planctl_git_repo fixture chdir'd).
    """
    from pathlib import Path

    from .conftest import seed_epic

    env = {"PLANCTL_ACTOR": actor}
    epic_id, task_ids = seed_epic(Path.cwd(), title="Claim epic", n_tasks=1, env=env)
    return epic_id, task_ids[0]


def _has_invocation_line(output: str) -> bool:
    return any("planctl_invocation" in ln for ln in output.strip().splitlines())


# ---------------------------------------------------------------------------
# Happy path: brief-handle briefing envelope + on-disk brief file
# ---------------------------------------------------------------------------


def test_claim_happy_path_envelope(planctl_git_repo):
    from pathlib import Path

    epic_id, task_id = _make_epic_with_task()

    r = _invoke(["claim", task_id], env={"PLANCTL_ACTOR": "alice@example.com"})
    assert r.exit_code == 0, r.output
    payload = _first_line_json(r.output)

    # Envelope carries a brief_ref handle, NOT the inlined prose fields.
    assert payload["success"] is True
    assert payload["task_id"] == task_id
    assert payload["epic_id"] == epic_id
    assert payload["target_repo"]  # resolved, non-empty
    assert payload["primary_repo"]
    assert "tier" in payload  # may be None when unset
    assert payload["task_state"]["status"] == "in_progress"
    assert payload["task_state"]["assignee"] == "alice@example.com"
    assert payload["task_state"]["outcome"] == "CLAIMED"
    assert payload["epic_state"]["id"] == epic_id

    # The three prose fields are GONE from the envelope.
    assert "task_spec_md" not in payload
    assert "epic_spec_md" not in payload
    assert "snippet_context" not in payload

    # brief_ref is present and absolute, pointing at state/briefs/<task_id>.json.
    brief_ref = payload["brief_ref"]
    assert brief_ref
    brief_path = Path(brief_ref)
    assert brief_path.is_absolute()
    assert brief_path.name == f"{task_id}.json"
    assert brief_path.parent.name == "briefs"
    assert brief_path.exists()

    # The on-disk brief parses with the full schema.
    brief = json.loads(brief_path.read_text(encoding="utf-8"))
    assert brief["schema_version"] == 1
    assert isinstance(brief["schema_version"], int)
    assert brief["generated_at"]
    assert brief["task_id"] == task_id
    assert brief["epic_id"] == epic_id
    assert brief["target_repo"] == payload["target_repo"]
    assert brief["primary_repo"] == payload["primary_repo"]
    # state_repo = epic.primary_repo falling back to repo_root.
    assert brief["state_repo"] == payload["primary_repo"]
    assert "tier" in brief
    assert "task_spec_md" in brief
    assert "epic_spec_md" in brief
    # No snippets seeded → empty render, present as "" (not omitted).
    assert brief["snippet_context"] == ""

    # claim stays readonly — NULL subject/files, no commit.
    assert payload["planctl_invocation"]["op"] == "claim"
    assert payload["planctl_invocation"]["subject"] is None
    assert payload["planctl_invocation"]["files"] is None


def test_claim_brief_file_is_gitignored(planctl_git_repo):
    """The brief lands under gitignored state/ — git never sees it as tracked."""
    from pathlib import Path

    _epic_id, task_id = _make_epic_with_task()
    r = _invoke(["claim", task_id], env={"PLANCTL_ACTOR": "alice@example.com"})
    assert r.exit_code == 0, r.output
    brief_path = Path(_first_line_json(r.output)["brief_ref"])
    assert brief_path.exists()

    # `git status --porcelain` of the brief path returns nothing → ignored.
    status = subprocess.run(
        ["git", "status", "--porcelain", "--", str(brief_path)],
        cwd=str(planctl_git_repo),
        capture_output=True,
        text=True,
        check=True,
    )
    assert status.stdout.strip() == "", status.stdout
    # And git agrees it is ignored.
    ignored = subprocess.run(
        ["git", "check-ignore", str(brief_path)],
        cwd=str(planctl_git_repo),
        capture_output=True,
        text=True,
    )
    assert ignored.returncode == 0, "brief path should be gitignored"


def test_claim_already_mine_regenerates_brief(planctl_git_repo):
    """An ALREADY_MINE re-claim re-writes the brief (repair-on-reclaim)."""
    from pathlib import Path

    env = {"PLANCTL_ACTOR": "alice@example.com"}
    _epic_id, task_id = _make_epic_with_task()

    r1 = _invoke(["claim", task_id], env=env)
    assert r1.exit_code == 0, r1.output
    brief_path = Path(_first_line_json(r1.output)["brief_ref"])
    # Delete the brief to simulate a missing/corrupt cache.
    brief_path.unlink()
    assert not brief_path.exists()

    r2 = _invoke(["claim", task_id], env=env)
    assert r2.exit_code == 0, r2.output
    payload2 = _first_line_json(r2.output)
    assert payload2["task_state"]["outcome"] == "ALREADY_MINE"
    # Brief regenerated by the idempotent re-claim.
    assert brief_path.exists()
    assert payload2["brief_ref"] == str(brief_path)


# ---------------------------------------------------------------------------
# Typed error codes
# ---------------------------------------------------------------------------


def test_claim_bad_task_id(planctl_git_repo):
    r = _invoke(["claim", "not-a-task-id"])
    assert r.exit_code == 1, r.output
    payload = _first_line_json(r.output)
    assert payload["success"] is False
    assert payload["error"]["code"] == "BAD_TASK_ID"
    assert not _has_invocation_line(r.output)


def test_claim_task_not_found(planctl_git_repo):
    r = _invoke(["claim", "fn-999-nonexistent.1"])
    assert r.exit_code == 1, r.output
    payload = _first_line_json(r.output)
    assert payload["error"]["code"] == "TASK_NOT_FOUND"
    assert not _has_invocation_line(r.output)


def test_claim_not_a_project(tmp_path):
    # --project pointing at a bare directory with no .planctl/ → NOT_A_PROJECT.
    bare = tmp_path / "bare"
    bare.mkdir()
    r = _invoke(["claim", "fn-1-x.1", "--project", str(bare)])
    assert r.exit_code == 1, r.output
    payload = _first_line_json(r.output)
    assert payload["error"]["code"] == "NOT_A_PROJECT"
    assert not _has_invocation_line(r.output)


def test_claim_task_done(planctl_git_repo):
    _epic_id, task_id = _make_epic_with_task()
    _invoke(["claim", task_id, "--force"])
    r = _invoke(["done", task_id, "--summary", "ok", "--force"])
    assert r.exit_code == 0, r.output

    r = _invoke(["claim", task_id])
    assert r.exit_code == 1, r.output
    payload = _first_line_json(r.output)
    assert payload["error"]["code"] == "TASK_DONE"
    assert not _has_invocation_line(r.output)


def test_claim_task_done_force_does_not_override(planctl_git_repo):
    """--force must NEVER override TASK_DONE."""
    _epic_id, task_id = _make_epic_with_task()
    _invoke(["claim", task_id, "--force"])
    _invoke(["done", task_id, "--summary", "ok", "--force"])

    r = _invoke(["claim", task_id, "--force"])
    assert r.exit_code == 1, r.output
    payload = _first_line_json(r.output)
    assert payload["error"]["code"] == "TASK_DONE"


def test_claim_task_blocked(planctl_git_repo):
    _epic_id, task_id = _make_epic_with_task()
    r = _invoke(["block", task_id, "--reason", "waiting"])
    assert r.exit_code == 0, r.output

    r = _invoke(["claim", task_id])
    assert r.exit_code == 1, r.output
    payload = _first_line_json(r.output)
    assert payload["error"]["code"] == "TASK_BLOCKED"
    assert not _has_invocation_line(r.output)


def test_claim_blocked_bypassed_by_force(planctl_git_repo):
    _epic_id, task_id = _make_epic_with_task()
    _invoke(["block", task_id, "--reason", "waiting"])

    r = _invoke(["claim", task_id, "--force"])
    assert r.exit_code == 0, r.output
    payload = _first_line_json(r.output)
    assert payload["task_state"]["status"] == "in_progress"


def test_claim_deps_unmet(planctl_git_repo):
    from pathlib import Path

    from .conftest import seed_epic

    env = {"PLANCTL_ACTOR": "alice@example.com"}
    # Two-task epic; t2 (ordinal 2) depends on t1 (ordinal 1).
    _epic_id, task_ids = seed_epic(
        Path.cwd(), title="Deps epic", n_tasks=2, task_deps={2: [1]}, env=env
    )
    t1, t2 = task_ids[0], task_ids[1]

    # t1 not done → t2's claim must report DEPS_UNMET.
    r = _invoke(["claim", t2], env=env)
    assert r.exit_code == 1, r.output
    payload = _first_line_json(r.output)
    assert payload["error"]["code"] == "DEPS_UNMET"
    assert payload["error"]["details"]["unmet"] == [t1]
    assert not _has_invocation_line(r.output)


def test_claim_deps_unmet_bypassed_by_force(planctl_git_repo):
    from pathlib import Path

    from .conftest import seed_epic

    env = {"PLANCTL_ACTOR": "alice@example.com"}
    _epic_id, task_ids = seed_epic(
        Path.cwd(), title="Deps epic", n_tasks=2, task_deps={2: [1]}, env=env
    )
    t2 = task_ids[1]

    r = _invoke(["claim", t2, "--force"], env=env)
    assert r.exit_code == 0, r.output


# ---------------------------------------------------------------------------
# CAS outcomes
# ---------------------------------------------------------------------------


def test_claim_already_mine_idempotent(planctl_git_repo):
    env = {"PLANCTL_ACTOR": "alice@example.com"}
    _epic_id, task_id = _make_epic_with_task()

    r1 = _invoke(["claim", task_id], env=env)
    assert r1.exit_code == 0, r1.output
    first = _first_line_json(r1.output)
    assert first["task_state"]["outcome"] == "CLAIMED"
    first_claimed_at = first["task_state"]["claimed_at"]

    # Re-claim by the same actor: idempotent, preserves claimed_at.
    r2 = _invoke(["claim", task_id], env=env)
    assert r2.exit_code == 0, r2.output
    second = _first_line_json(r2.output)
    assert second["success"] is True
    assert second["task_state"]["outcome"] == "ALREADY_MINE"
    assert second["task_state"]["claimed_at"] == first_claimed_at


def test_claim_by_other_errors(planctl_git_repo):
    _epic_id, task_id = _make_epic_with_task()
    r = _invoke(["claim", task_id], env={"PLANCTL_ACTOR": "alice@example.com"})
    assert r.exit_code == 0, r.output

    # Bob tries to claim Alice's in-progress task.
    r = _invoke(["claim", task_id], env={"PLANCTL_ACTOR": "bob@example.com"})
    assert r.exit_code == 1, r.output
    payload = _first_line_json(r.output)
    assert payload["error"]["code"] == "CLAIMED_BY_OTHER"
    assert payload["error"]["details"]["assignee"] == "alice@example.com"
    assert not _has_invocation_line(r.output)


def test_claim_force_takeover(planctl_git_repo):
    _epic_id, task_id = _make_epic_with_task()
    _invoke(["claim", task_id], env={"PLANCTL_ACTOR": "alice@example.com"})

    # Bob takes over with --force.
    r = _invoke(["claim", task_id, "--force"], env={"PLANCTL_ACTOR": "bob@example.com"})
    assert r.exit_code == 0, r.output
    payload = _first_line_json(r.output)
    assert payload["task_state"]["assignee"] == "bob@example.com"
    assert payload["task_state"]["outcome"] == "CLAIMED"
    assert "Taken over from alice@example.com" in payload["task_state"]["claim_note"]


# ---------------------------------------------------------------------------
# SNIPPET_RENDER_FAILED + no-audit-row-on-failure
# ---------------------------------------------------------------------------


def test_claim_snippet_render_failed(planctl_git_repo, monkeypatch):
    from pathlib import Path

    _epic_id, task_id = _make_epic_with_task()

    real_run = subprocess.run

    def _fake_run(cmd, *args, **kwargs):
        if cmd[:2] == ["promptctl", "render-spec"]:
            return subprocess.CompletedProcess(
                cmd, returncode=2, stdout="", stderr="boom"
            )
        return real_run(cmd, *args, **kwargs)

    # The render now lives in planctl.brief; monkeypatch its subprocess.
    monkeypatch.setattr("planctl.brief.subprocess.run", _fake_run)

    r = _invoke(["claim", task_id])
    assert r.exit_code == 1, r.output
    payload = _first_line_json(r.output)
    assert payload["error"]["code"] == "SNIPPET_RENDER_FAILED"
    # No mutation happened — task stays todo, no audit row.
    assert not _has_invocation_line(r.output)

    # The brief is assembled BEFORE the CAS: a render failure aborts before any
    # brief file is written.
    brief_path = (
        Path(planctl_git_repo) / ".planctl" / "state" / "briefs" / f"{task_id}.json"
    )
    assert not brief_path.exists()

    # Render failure aborts BEFORE the CAS: the task is still todo, so a
    # subsequent (un-patched) claim transitions todo→in_progress (CLAIMED),
    # not ALREADY_MINE.
    monkeypatch.setattr("planctl.brief.subprocess.run", real_run)
    r2 = _invoke(["claim", task_id], env={"PLANCTL_ACTOR": "alice@example.com"})
    assert r2.exit_code == 0, r2.output
    payload2 = _first_line_json(r2.output)
    assert payload2["task_state"]["outcome"] == "CLAIMED"


def test_claim_brief_write_failed_leaves_in_progress(planctl_git_repo, monkeypatch):
    """A brief-write failure surfaces BRIEF_WRITE_FAILED but leaves task in_progress.

    The brief write happens AFTER save_runtime inside the lock; a failure there
    must NOT unwind the state write (repair-on-reclaim).
    """
    from pathlib import Path

    _epic_id, task_id = _make_epic_with_task()

    real_write = __import__("planctl.brief", fromlist=["write_brief"]).write_brief

    def _boom(*_args, **_kwargs):
        raise OSError("disk full")

    # Patch only the brief writer (not the autouse roots config); undo by
    # restoring the real callable so the follow-up claim still resolves roots.
    monkeypatch.setattr("planctl.brief.write_brief", _boom)

    r = _invoke(["claim", task_id], env={"PLANCTL_ACTOR": "alice@example.com"})
    assert r.exit_code == 1, r.output
    payload = _first_line_json(r.output)
    assert payload["error"]["code"] == "BRIEF_WRITE_FAILED"

    # save_runtime already landed inside the lock before the write failed — the
    # state write is NOT unwound. No brief file exists yet.
    brief_path = (
        Path(planctl_git_repo) / ".planctl" / "state" / "briefs" / f"{task_id}.json"
    )
    assert not brief_path.exists()

    # Re-claim with the real writer: ALREADY_MINE confirms the task stayed
    # in_progress (owned by alice) and the brief regenerates (repair-on-reclaim).
    monkeypatch.setattr("planctl.brief.write_brief", real_write)
    r2 = _invoke(["claim", task_id], env={"PLANCTL_ACTOR": "alice@example.com"})
    assert r2.exit_code == 0, r2.output
    payload2 = _first_line_json(r2.output)
    assert payload2["task_state"]["status"] == "in_progress"
    assert payload2["task_state"]["outcome"] == "ALREADY_MINE"
    assert brief_path.exists()


# ---------------------------------------------------------------------------
# Cwd-agnostic project resolution (fn-542 task .3)
# ---------------------------------------------------------------------------


def _git_init(repo) -> None:
    """git init + an initial commit so the dir is a clean repo.

    Committer identity, ``commit.gpgsign=false`` and ``core.hooksPath=/dev/null``
    ride the session-scoped ``GIT_CONFIG_GLOBAL`` set by ``_git_global_config``,
    so no per-repo ``git config`` is needed here.
    """
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
    (repo / "README.md").write_text("# repo\n")
    subprocess.run(
        ["git", "add", "README.md"], cwd=repo, check=True, capture_output=True
    )
    subprocess.run(
        ["git", "commit", "-m", "init"], cwd=repo, check=True, capture_output=True
    )


# Pin the session id so each mutating verb's session-id resolution short-circuits
# the env lookup instead of fork-exec'ing ``ps`` per ancestor (which can blow the
# pytest 3s signal timeout under heavy parallel xdist load — see conftest).
_RESOLUTION_ENV = {
    "PLANCTL_ACTOR": "alice@example.com",
    "CLAUDE_CODE_SESSION_ID": "test-claim-resolution-fixture",
}


def _init_project_with_task(monkeypatch, proj, *, actor="alice@example.com") -> str:
    """git+planctl init a project at *proj*, scaffold an epic+task, return task_id."""
    from .conftest import seed_epic

    proj.mkdir(parents=True, exist_ok=True)
    _git_init(proj)
    env = {**_RESOLUTION_ENV, "PLANCTL_ACTOR": actor}
    monkeypatch.chdir(proj)
    r = _invoke(["init"], env=env)
    assert r.exit_code == 0, r.output
    _epic_id, task_ids = seed_epic(proj, title="Discovery epic", n_tasks=1, env=env)
    return task_ids[0]


def _point_roots_at(monkeypatch, tmp_path, root) -> None:
    cfg = tmp_path / "_resolution_roots.yaml"
    cfg.write_text(f"roots:\n  - {root}\n", encoding="utf-8")
    monkeypatch.setattr("planctl.config.CONFIG_PATH", cfg)


def test_claim_zero_arg_resolves_non_cwd_project(tmp_path, monkeypatch):
    """Zero-arg claim resolves the owning project via roots, independent of cwd."""
    root = tmp_path / "code"
    root.mkdir()
    proj = root / "alpha"
    task_id = _init_project_with_task(monkeypatch, proj)
    _point_roots_at(monkeypatch, tmp_path, root)

    # Run from an unrelated cwd — discovery, not cwd, locates the project.
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)

    r = _invoke(["claim", task_id], env=_RESOLUTION_ENV)
    assert r.exit_code == 0, r.output
    payload = _first_line_json(r.output)
    assert payload["success"] is True
    assert payload["task_id"] == task_id
    assert payload["task_state"]["status"] == "in_progress"
    assert str(proj.resolve()) in payload["target_repo"]


def test_claim_project_override_bypasses_discovery(tmp_path, monkeypatch):
    """--project resolves a project directly, even when roots don't include it."""
    proj = tmp_path / "out-of-roots" / "alpha"
    task_id = _init_project_with_task(monkeypatch, proj)
    # Roots deliberately point somewhere that does NOT contain the project.
    empty_root = tmp_path / "empty-root"
    empty_root.mkdir()
    _point_roots_at(monkeypatch, tmp_path, empty_root)
    monkeypatch.chdir(empty_root)

    r = _invoke(
        ["claim", task_id, "--project", str(proj)],
        env=_RESOLUTION_ENV,
    )
    assert r.exit_code == 0, r.output
    payload = _first_line_json(r.output)
    assert payload["task_id"] == task_id
    assert payload["task_state"]["status"] == "in_progress"


def test_claim_project_override_task_not_found(tmp_path, monkeypatch):
    """--project at a real project missing the task → TASK_NOT_FOUND."""
    proj = tmp_path / "code" / "alpha"
    _init_project_with_task(monkeypatch, proj)
    r = _invoke(["claim", "fn-999-absent.1", "--project", str(proj)])
    assert r.exit_code == 1, r.output
    payload = _first_line_json(r.output)
    assert payload["error"]["code"] == "TASK_NOT_FOUND"
    assert not _has_invocation_line(r.output)


def test_claim_ambiguous_task_id(tmp_path, monkeypatch):
    """Same task id claimable in two projects under one root → AMBIGUOUS_TASK_ID."""
    root = tmp_path / "code"
    root.mkdir()
    proj_a = root / "alpha"
    proj_b = root / "beta"
    task_a = _init_project_with_task(monkeypatch, proj_a)

    # Mint a colliding id in proj_b by copying alpha's epic + task JSON/spec
    # directly (global numbering would otherwise hand beta a higher fn-N).
    epic_id = task_a.rsplit(".", 1)[0]
    _init_project_with_task(monkeypatch, proj_b)  # gives beta a working .planctl/
    for sub, name in (
        ("epics", f"{epic_id}.json"),
        ("tasks", f"{task_a}.json"),
        ("specs", f"{epic_id}.md"),
        ("specs", f"{task_a}.md"),
    ):
        src = proj_a / ".planctl" / sub / name
        if src.exists():
            dst = proj_b / ".planctl" / sub / name
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")

    _point_roots_at(monkeypatch, tmp_path, root)

    r = _invoke(["claim", task_a], env=_RESOLUTION_ENV)
    assert r.exit_code == 1, r.output
    payload = _first_line_json(r.output)
    assert payload["error"]["code"] == "AMBIGUOUS_TASK_ID"
    candidates = payload["error"]["details"]["candidates"]
    assert str(proj_a.resolve()) in candidates
    assert str(proj_b.resolve()) in candidates
    assert not _has_invocation_line(r.output)

    # The --project escape hatch resolves the ambiguity deterministically.
    r2 = _invoke(
        ["claim", task_a, "--project", str(proj_a)],
        env=_RESOLUTION_ENV,
    )
    assert r2.exit_code == 0, r2.output


def test_claim_ambiguous_resolved_by_claimable_filter(tmp_path, monkeypatch):
    """Same id in two projects, only one claimable (open epic) → resolves silently."""
    root = tmp_path / "code"
    root.mkdir()
    proj_a = root / "alpha"
    proj_b = root / "beta"
    task_a = _init_project_with_task(monkeypatch, proj_a)
    epic_id = task_a.rsplit(".", 1)[0]
    _init_project_with_task(monkeypatch, proj_b)

    # Copy alpha's id into beta but mark beta's epic closed → not claimable there.
    for sub, name in (
        ("epics", f"{epic_id}.json"),
        ("tasks", f"{task_a}.json"),
        ("specs", f"{epic_id}.md"),
        ("specs", f"{task_a}.md"),
    ):
        src = proj_a / ".planctl" / sub / name
        if src.exists():
            dst = proj_b / ".planctl" / sub / name
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    beta_epic = proj_b / ".planctl" / "epics" / f"{epic_id}.json"
    epic_obj = json.loads(beta_epic.read_text(encoding="utf-8"))
    epic_obj["status"] = "closed"
    beta_epic.write_text(json.dumps(epic_obj), encoding="utf-8")

    _point_roots_at(monkeypatch, tmp_path, root)

    # Only alpha is claimable → resolves there without --project.
    r = _invoke(["claim", task_a], env=_RESOLUTION_ENV)
    assert r.exit_code == 0, r.output
    payload = _first_line_json(r.output)
    assert payload["task_state"]["status"] == "in_progress"
    assert str(proj_a.resolve()) in payload["target_repo"]
