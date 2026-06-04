"""Tests for `planctl epic rm` (fn-623 task .1).

Companion to test_epic_close.py: where `close` only stamps `closer_done_at`,
`rm` physically unlinks every artifact and auto-commits the deletions.

Covers:
  * happy path: full artifact set removed + auto-commit stages the deletions
    so HEAD reflects the removal (the deletion → commit wiring is the
    single biggest silent-failure surface — see the task spec).
  * `--dry-run` writes nothing.
  * `in_progress` tasks block deletion without `--force`; proceed with it.
  * Missing epic → clean error (not a crash).
  * Ambiguous id across discovered roots → hard error listing owners;
    `--project` disambiguates.
  * Traversal guard rejects malformed ids.
  * Dependent epics are surfaced as warnings, not blockers.
  * `"rm"` is registered in VERB_TEMPLATES (build_subject would KeyError).
"""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
from pathlib import Path

import pytest
from click.testing import CliRunner
from planctl.cli import cli

from .conftest import parse_cli_output, seed_epic

_ENV = {**os.environ, "CLAUDE_CODE_SESSION_ID": "test-epic-rm-fixture"}


def _invoke(args: list[str]) -> tuple[int, dict | None, str]:
    """Invoke planctl CLI, returning (exit_code, parsed_payload, raw_output).

    Read-only verbs (dry-run, errors) emit multi-line pretty JSON via
    `format_output`; mutating verbs emit single-line NDJSON via `emit()`.
    Try `parse_cli_output` (handles both), then fall back to the
    first-JSON-line scan for failure envelopes that don't shape as the
    standard payload.
    """
    runner = CliRunner()
    env = {**_ENV}
    result = runner.invoke(cli, args, env=env)
    obj: dict | None = None
    with contextlib.suppress(Exception):
        obj = parse_cli_output(result.output)
    if obj is None:
        for line in result.output.strip().splitlines():
            line = line.strip()
            if line.startswith("{"):
                with contextlib.suppress(json.JSONDecodeError):
                    obj = json.loads(line)
                    break
    return result.exit_code, obj, result.output


def _head_files(repo: Path) -> list[str]:
    """Return paths changed in the HEAD commit."""
    result = subprocess.run(
        ["git", "diff-tree", "--no-commit-id", "-r", "--name-only", "HEAD"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    )
    return [ln.strip() for ln in result.stdout.splitlines() if ln.strip()]


def _head_subject(repo: Path) -> str:
    """Return the subject line (first line) of HEAD's commit message."""
    result = subprocess.run(
        ["git", "log", "-1", "--format=%s"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def _tracked(repo: Path, rel: str) -> bool:
    """Whether *rel* is present in the current HEAD tree."""
    result = subprocess.run(
        ["git", "ls-files", "--error-unmatch", "--", rel],
        cwd=repo,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


# ---------------------------------------------------------------------------
# Happy path: full artifact set is unlinked AND the auto-commit lands it
# ---------------------------------------------------------------------------


def test_rm_unlinks_full_artifact_set_and_commits(planctl_git_repo, monkeypatch):
    """Happy path: every artifact category vanishes and the auto-commit
    actually stages the deletions (HEAD shows them removed).

    This is the load-bearing assertion called out in the task spec —
    `_record_touched` must be called before `unlink`, or the deletions
    get filtered out of the `touched ∩ dirty` pathspec and silently never
    commit.
    """
    monkeypatch.chdir(planctl_git_repo)
    epic_id, task_ids = seed_epic(planctl_git_repo, n_tasks=2)
    assert len(task_ids) == 2

    # Sanity: every artifact category exists pre-rm.
    epic_json = planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json"
    epic_spec = planctl_git_repo / ".planctl" / "specs" / f"{epic_id}.md"
    task_jsons = [
        planctl_git_repo / ".planctl" / "tasks" / f"{tid}.json" for tid in task_ids
    ]
    task_specs = [
        planctl_git_repo / ".planctl" / "specs" / f"{tid}.md" for tid in task_ids
    ]
    for p in [epic_json, epic_spec, *task_jsons, *task_specs]:
        assert p.exists(), f"pre-rm artifact missing: {p}"

    # Plant a state file for one task so we exercise the state cleanup
    # path too (scaffold doesn't materialize runtime state).
    state_tasks_dir = planctl_git_repo / ".planctl" / "state" / "tasks"
    state_tasks_dir.mkdir(parents=True, exist_ok=True)
    state_file = state_tasks_dir / f"{task_ids[0]}.state.json"
    state_file.write_text('{"status": "todo"}\n', encoding="utf-8")

    code, obj, output = _invoke(["epic", "rm", epic_id])
    assert code == 0, output
    assert obj is not None
    assert obj["success"] is True
    assert obj["epic_id"] == epic_id
    assert obj["task_count"] == len(task_ids)

    # Every artifact is gone from disk.
    for p in [epic_json, epic_spec, *task_jsons, *task_specs, state_file]:
        assert not p.exists(), f"post-rm artifact still present: {p}"

    # The auto-commit landed: HEAD shows the deletions, NOT just an empty
    # commit. This catches the `_record_touched`-before-unlink bug — if
    # `_record_touched` were skipped, the deletions wouldn't appear in
    # touched ∩ dirty, the auto-commit would no-op, and the files would be
    # gone from disk but still tracked in HEAD.
    head_files_changed = _head_files(planctl_git_repo)
    epic_rel = f".planctl/epics/{epic_id}.json"
    assert epic_rel in head_files_changed, (
        f"epic JSON deletion did not land in HEAD; head_files={head_files_changed}"
    )
    for tid in task_ids:
        task_rel = f".planctl/tasks/{tid}.json"
        assert task_rel in head_files_changed, (
            f"task {tid} JSON deletion did not land in HEAD"
        )
        spec_rel = f".planctl/specs/{tid}.md"
        assert spec_rel in head_files_changed, (
            f"task {tid} spec deletion did not land in HEAD"
        )

    # And it's no longer in HEAD tree.
    assert not _tracked(planctl_git_repo, epic_rel)
    for tid in task_ids:
        assert not _tracked(planctl_git_repo, f".planctl/tasks/{tid}.json")

    # Commit subject uses the canonical chore(planctl): rm <epic_id> form.
    subject = _head_subject(planctl_git_repo)
    assert subject == f"chore(planctl): rm {epic_id}", subject

    # Envelope carries the standard planctl_invocation with op=rm.
    inv = obj.get("planctl_invocation") or {}
    assert inv.get("op") == "rm"
    assert inv.get("target") == epic_id


# ---------------------------------------------------------------------------
# --dry-run: writes nothing
# ---------------------------------------------------------------------------


def test_rm_dry_run_writes_nothing(planctl_git_repo, monkeypatch):
    """`--dry-run` previews the unlink set and exits without deleting."""
    monkeypatch.chdir(planctl_git_repo)
    epic_id, task_ids = seed_epic(planctl_git_repo, n_tasks=1)
    epic_json = planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json"
    task_json = planctl_git_repo / ".planctl" / "tasks" / f"{task_ids[0]}.json"

    head_pre = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=planctl_git_repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()

    code, obj, output = _invoke(["epic", "rm", epic_id, "--dry-run"])
    assert code == 0, output
    assert obj is not None
    assert obj.get("dry_run") is True
    # Removed_files lists everything that WOULD be deleted.
    rels = obj["removed_files"]
    assert f".planctl/epics/{epic_id}.json" in rels
    assert f".planctl/tasks/{task_ids[0]}.json" in rels

    # Disk unchanged.
    assert epic_json.exists()
    assert task_json.exists()

    # No commit landed.
    head_post = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=planctl_git_repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert head_pre == head_post


# ---------------------------------------------------------------------------
# in_progress / lock guard
# ---------------------------------------------------------------------------


def test_rm_blocked_by_in_progress_without_force(planctl_git_repo, monkeypatch):
    """A task with runtime status `in_progress` blocks rm unless --force."""
    monkeypatch.chdir(planctl_git_repo)
    epic_id, task_ids = seed_epic(planctl_git_repo, n_tasks=1)

    # Plant in_progress runtime state for the task.
    state_tasks_dir = planctl_git_repo / ".planctl" / "state" / "tasks"
    state_tasks_dir.mkdir(parents=True, exist_ok=True)
    (state_tasks_dir / f"{task_ids[0]}.state.json").write_text(
        '{"status": "in_progress"}\n', encoding="utf-8"
    )

    code, obj, output = _invoke(["epic", "rm", epic_id])
    assert code != 0, output
    assert obj is not None
    assert obj["success"] is False
    # The error names the live task and the --force escape.
    assert "in_progress" in obj["error"]
    assert "--force" in obj["error"]

    # Nothing deleted.
    epic_json = planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json"
    assert epic_json.exists()


def test_rm_force_overrides_in_progress_guard(planctl_git_repo, monkeypatch):
    """`--force` skips the live-work check and deletes regardless."""
    monkeypatch.chdir(planctl_git_repo)
    epic_id, task_ids = seed_epic(planctl_git_repo, n_tasks=1)

    state_tasks_dir = planctl_git_repo / ".planctl" / "state" / "tasks"
    state_tasks_dir.mkdir(parents=True, exist_ok=True)
    (state_tasks_dir / f"{task_ids[0]}.state.json").write_text(
        '{"status": "in_progress"}\n', encoding="utf-8"
    )

    code, obj, output = _invoke(["epic", "rm", epic_id, "--force"])
    assert code == 0, output
    assert obj is not None
    assert obj["success"] is True
    epic_json = planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json"
    assert not epic_json.exists()


# ---------------------------------------------------------------------------
# Missing epic / traversal guard
# ---------------------------------------------------------------------------


def test_rm_missing_epic_clean_error(planctl_git_repo, monkeypatch):
    """An id that doesn't exist yields a clean error, not a crash."""
    monkeypatch.chdir(planctl_git_repo)
    code, obj, output = _invoke(["epic", "rm", "fn-9999-nope"])
    assert code != 0, output
    assert obj is not None
    assert obj["success"] is False
    assert "fn-9999-nope" in obj["error"]


def test_rm_traversal_guard_rejects_bad_id(planctl_git_repo, monkeypatch):
    """An id with path-separator / `.` / etc. is rejected before any glob."""
    monkeypatch.chdir(planctl_git_repo)
    code, obj, output = _invoke(["epic", "rm", "../escape"])
    assert code != 0, output
    assert obj is not None
    assert obj["success"] is False
    assert "Invalid epic id" in obj["error"]


# ---------------------------------------------------------------------------
# Ambiguous resolution + --project escape
# ---------------------------------------------------------------------------


def _bootstrap_project(repo: Path) -> None:
    """Initialize a project as a planctl repo (git init + planctl init +
    baseline commit so commits aren't blocked by a missing parent ref).
    """
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
    for k, v in [
        ("user.email", "test@example.com"),
        ("user.name", "Test User"),
        ("commit.gpgsign", "false"),
        ("core.hooksPath", "/dev/null"),
    ]:
        subprocess.run(
            ["git", "config", k, v], cwd=repo, check=True, capture_output=True
        )
    (repo / "README.md").write_text("# Test repo\n")
    subprocess.run(
        ["git", "add", "README.md"], cwd=repo, check=True, capture_output=True
    )
    subprocess.run(
        ["git", "commit", "-m", "chore: initial"],
        cwd=repo,
        check=True,
        capture_output=True,
    )
    runner = CliRunner()
    result = runner.invoke(cli, ["init"], env={**_ENV, "PWD": str(repo)})
    assert result.exit_code == 0, result.output


@pytest.fixture
def two_projects(tmp_path, monkeypatch):
    """Two sibling planctl projects under a shared `roots` parent.

    Both get the SAME epic id forced onto disk (legacy dup state) so we
    can exercise the ambiguous-id resolution path.

    Returns (root_parent, project_a, project_b, dup_epic_id).
    """
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-epic-rm-fixture")

    parent = tmp_path / "roots"
    parent.mkdir()
    proj_a = parent / "proj_a"
    proj_b = parent / "proj_b"
    proj_a.mkdir()
    proj_b.mkdir()

    # Need to chdir per init so `planctl init` resolves the right project.
    monkeypatch.chdir(proj_a)
    _bootstrap_project(proj_a)
    monkeypatch.chdir(proj_b)
    _bootstrap_project(proj_b)

    # Seed an epic in each project (under cwd) so the slug is the same.
    # `seed_epic` calls scaffold from cwd — set chdir per call.
    monkeypatch.chdir(proj_a)
    epic_a, _ = seed_epic(proj_a, title="Ambiguous epic")
    monkeypatch.chdir(proj_b)
    epic_b, _ = seed_epic(proj_b, title="Ambiguous epic")

    # If allocator drift means the two ids differ, force a dup state by
    # renaming proj_b's artifacts to match proj_a's id. This is the
    # "legacy dup" scenario the resolver is built to refuse silently
    # picking on — we're synthesizing it deterministically.
    if epic_a != epic_b:
        for sub in ("epics", "specs"):
            d = proj_b / ".planctl" / sub
            if d.exists():
                for f in list(d.iterdir()):
                    if epic_b in f.name:
                        new_name = f.name.replace(epic_b, epic_a)
                        f.rename(d / new_name)
        d = proj_b / ".planctl" / "tasks"
        if d.exists():
            for f in list(d.iterdir()):
                if epic_b in f.name:
                    f.rename(d / f.name.replace(epic_b, epic_a))
        # And patch the epic-json id field so downstream readers don't
        # trip on a stale value.
        epic_b_json = proj_b / ".planctl" / "epics" / f"{epic_a}.json"
        if epic_b_json.exists():
            data = json.loads(epic_b_json.read_text())
            data["id"] = epic_a
            epic_b_json.write_text(json.dumps(data, indent=2) + "\n")

    # Point planctl at the configured roots parent so discovery sees both
    # projects. `load_roots` reads its config file path from
    # `planctl.config.CONFIG_PATH`; monkeypatch it onto a temp YAML so the
    # test never touches the real `~/.config/planctl/config.yaml`.
    config_path = tmp_path / "planctl_config.yaml"
    config_path.write_text(f"roots:\n  - {parent}\n", encoding="utf-8")
    monkeypatch.setattr("planctl.config.CONFIG_PATH", config_path)

    return parent, proj_a, proj_b, epic_a


def test_rm_ambiguous_id_errors_with_owners(two_projects, monkeypatch):
    """An id that exists in two projects hard-errors listing both owners."""
    parent, proj_a, proj_b, dup_id = two_projects
    # Run from OUTSIDE either project so cwd short-circuit doesn't pick one.
    outside = parent.parent
    monkeypatch.chdir(outside)

    code, obj, output = _invoke(["epic", "rm", dup_id])
    assert code != 0, output
    assert obj is not None
    assert obj["success"] is False
    assert "multiple projects" in obj["error"]
    assert "--project" in obj["error"]
    assert str(proj_a) in obj["error"] or str(proj_b) in obj["error"]

    # Nothing deleted in either project.
    assert (proj_a / ".planctl" / "epics" / f"{dup_id}.json").exists()
    assert (proj_b / ".planctl" / "epics" / f"{dup_id}.json").exists()


def test_rm_project_flag_disambiguates(two_projects, monkeypatch):
    """`--project <path>` resolves the owning project on an ambiguous id."""
    parent, proj_a, proj_b, dup_id = two_projects
    outside = parent.parent
    monkeypatch.chdir(outside)

    code, obj, output = _invoke(["epic", "rm", dup_id, "--project", str(proj_a)])
    assert code == 0, output
    assert obj is not None
    assert obj["success"] is True

    # proj_a is gone; proj_b untouched.
    assert not (proj_a / ".planctl" / "epics" / f"{dup_id}.json").exists()
    assert (proj_b / ".planctl" / "epics" / f"{dup_id}.json").exists()


# ---------------------------------------------------------------------------
# Dependent surfacing (non-blocking warning)
# ---------------------------------------------------------------------------


def test_rm_surfaces_dependents_as_warning_not_blocker(planctl_git_repo, monkeypatch):
    """An epic that other epics depend on is still removable; dependents
    surface in `warnings` for the caller to act on."""
    monkeypatch.chdir(planctl_git_repo)
    target_id, _ = seed_epic(planctl_git_repo, title="Target")
    # Use refine-apply equivalent? Simpler: hand-edit the second epic's
    # depends_on_epics after scaffold.
    dependent_id, _ = seed_epic(planctl_git_repo, title="Dependent")
    dep_json = planctl_git_repo / ".planctl" / "epics" / f"{dependent_id}.json"
    data = json.loads(dep_json.read_text())
    data["depends_on_epics"] = [target_id]
    dep_json.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    # Commit the hand-edit so the state stays clean.
    subprocess.run(
        ["git", "add", str(dep_json)],
        cwd=planctl_git_repo,
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "commit", "-m", "chore: rig dep"],
        cwd=planctl_git_repo,
        check=True,
        capture_output=True,
    )

    code, obj, output = _invoke(["epic", "rm", target_id])
    assert code == 0, output
    assert obj is not None
    assert obj["success"] is True
    assert dependent_id in obj["dependents"]
    assert obj["warnings"], "dependents must surface as a warning"
    assert any(dependent_id in w for w in obj["warnings"])


# ---------------------------------------------------------------------------
# build_subject regression: VERB_TEMPLATES carries "rm"
# ---------------------------------------------------------------------------


def test_rm_registered_in_verb_templates():
    """`commit_messages.build_subject` would raise KeyError without this."""
    from planctl.commit_messages import VERB_TEMPLATES, build_subject

    assert "rm" in VERB_TEMPLATES
    subj = build_subject("rm", "fn-1-x")
    assert subj == "chore(planctl): rm fn-1-x"


# ---------------------------------------------------------------------------
# epic rm routes through the central seam at output.emit() instead of building
# build_planctl_invocation itself. rm is delete-only — there's nothing to
# re-create on a pre-commit raise (§10 no-rollback applies to the deletes the
# same as to writes), but the seam still owns the commit so a CommitFailed
# still produces the structured `commit_failed` envelope and the success
# envelope is NEVER printed. Regression: a missing CLAUDE_CODE_SESSION_ID surfaces
# from the seam the same way it does for scaffold / refine-apply.
# ---------------------------------------------------------------------------


def test_rm_missing_session_id_routes_through_seam(planctl_git_repo, monkeypatch):
    """CLAUDE_CODE_SESSION_ID unset → invocation-build raises from
    inside the seam (fn-629 task .2). The rm verb has nothing to unwind (delete-only), but the
    raise surfaces and the verb fails — the previous direct
    build_planctl_invocation call had the same behavior, but it ran outside
    the seam. Generalised consistency check.
    """
    monkeypatch.chdir(planctl_git_repo)
    epic_id, _ = seed_epic(planctl_git_repo, n_tasks=1)
    epic_json = planctl_git_repo / ".planctl" / "epics" / f"{epic_id}.json"
    assert epic_json.exists()

    # Strip the env var so the seam's build_planctl_invocation raises.
    # CliRunner.invoke env-dict overlays on os.environ, so we must delete
    # the variable in the process env too.
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
    runner = CliRunner()
    stripped_env = {k: v for k, v in _ENV.items() if k != "CLAUDE_CODE_SESSION_ID"}
    result = runner.invoke(cli, ["epic", "rm", epic_id], env=stripped_env)
    assert result.exit_code != 0, result.output


def test_rm_commit_failure_emits_structured_envelope(planctl_git_repo, monkeypatch):
    """fn-629 task .2: a CommitFailed from auto_commit_from_invocation
    yields the structured ``commit_failed`` envelope (NOT a success envelope),
    matching the existing emit() failure contract. The deletes already
    happened on disk pre-commit — §10 no-rollback applies (no re-create).
    """
    from planctl import commit as commit_module

    monkeypatch.chdir(planctl_git_repo)
    epic_id, _ = seed_epic(planctl_git_repo, n_tasks=1)

    def _boom(_):
        raise commit_module.CommitFailed(
            "git_commit", "synthesized epic rm commit rejection"
        )

    monkeypatch.setattr(commit_module, "auto_commit_from_invocation", _boom)

    code, obj, output = _invoke(["epic", "rm", epic_id])
    assert code == 1, output
    assert obj is not None
    # Structured failure envelope, NOT a success envelope.
    assert obj["success"] is False
    assert obj["error"] == "commit_failed"
    assert obj["details"]["error"] == "git_commit"


def test_rm_no_lock_nesting(planctl_git_repo, monkeypatch):
    """fn-629 task .2 acceptance (fn-640 retune): epic rm doesn't take the
    ``_epic_id_lock`` at all (it's a delete verb, no id allocation). Since
    fn-640 deleted the commit flock, we spy the surviving commit seam
    (``_git_commit``) to prove the auto-commit fires and no spurious id-lock
    acquisition leaks into the rm path.
    """
    import planctl.commit as _commit_mod
    import planctl.run_epic_create as _epic_create_mod

    monkeypatch.chdir(planctl_git_repo)

    events: list[str] = []
    original_lock = _epic_create_mod._epic_id_lock
    original_commit = _commit_mod._git_commit

    import contextlib as _ctxlib

    @_ctxlib.contextmanager
    def _spy_id_lock():
        events.append("id_lock:enter")
        with original_lock():
            try:
                yield
            finally:
                events.append("id_lock:exit")

    def _spy_commit(msg, files, cwd):
        events.append("commit:enter")
        sha = original_commit(msg, files, cwd)
        events.append("commit:done")
        return sha

    monkeypatch.setattr(_epic_create_mod, "_epic_id_lock", _spy_id_lock)
    monkeypatch.setattr(_commit_mod, "_git_commit", _spy_commit)

    epic_id, _ = seed_epic(planctl_git_repo, n_tasks=1)
    # The seed went through scaffold which took the id lock — clear so we
    # only assert on the rm path.
    events.clear()

    code, obj, output = _invoke(["epic", "rm", epic_id])
    assert code == 0, output
    assert obj is not None and obj["success"] is True

    # rm commits (HEAD advances) and NEVER touches the id lock — there's no
    # id to allocate.
    assert "commit:done" in events, events
    assert "id_lock:enter" not in events, (
        f"epic rm must not take the id-allocation lock; events: {events}"
    )
