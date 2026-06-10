"""Tests for the read-only `planctl find-task-commit <task_id>` verb (fn-9 task .1).

The verb wraps the shared `planctl.commit_lookup.find_commit_groups` native
trailer scan and emits the flat, keeper-compatible envelope the worker's
predecessor-detection branch consumes:
``{success: true, commits: [{sha, repo}]}``. A clean miss is an empty success
(exit 0); an all-repos-broken scan fails loud with `COMMIT_LOOKUP_FAILED`
(exit 1, `details.broken_repos`). The commit scan runs against real git commits
(the `planctl_git_repo` fixture git-inits the project root, so `primary_repo` is
a real repo) under the autouse hermetic git config.

Coverage (per the task's Test notes):
- single-task happy path: a real `Task:`-trailer commit → flat `commits:[{sha,repo}]`
- flatten correctness + order (repo-outer first-seen, per-repo grep order)
- clean miss → empty success exit 0
- prose-false-match dropped (via `_seed_commit(body=...)`)
- AllReposBrokenError → COMMIT_LOOKUP_FAILED + details.broken_repos, exit 1
- BAD_TASK_ID on a non-task id
- --project resolution / disambiguation
- read-only-no-commit (HEAD unchanged, no find-task-commit subject in git log)
- envelope carries the readonly planctl_invocation footer (op=find-task-commit)
"""

from __future__ import annotations

import contextlib
import json
import subprocess

import pytest
from click.testing import CliRunner
from planctl.cli import cli

# find-task-commit parses real ``Task:``-trailer commits via ``git log`` — the
# real commits ARE the subject under test, so ``real_git`` (slow bucket: real
# git history, no autocommit/dirty-probe stubs). It also drives roots discovery
# against the ``_roots_at_tmp_project`` CONFIG_PATH below, which must win over
# the autouse empty-discovery isolation — ``real_roots`` opts onto that
# controlled tmp root.
pytestmark = [pytest.mark.real_git, pytest.mark.real_roots]


@pytest.fixture(autouse=True)
def _roots_at_tmp_project(tmp_path, monkeypatch):
    """Point planctl roots discovery at an isolated root holding only ``tmp_path``.

    Same shape as ``tests/test_resolve_task.py::_roots_at_tmp_project`` — without
    this autouse fixture, discovery scans the real ``~/code`` default and can't
    find the seeded ``fn-N`` task → spurious TASK_NOT_FOUND. The ambiguity /
    --project tests override CONFIG_PATH themselves; the later ``setattr`` wins.
    """
    root = tmp_path / "_ftc_root"
    root.mkdir()
    (root / tmp_path.name).symlink_to(tmp_path, target_is_directory=True)
    cfg = tmp_path / "_ftc_roots_config.yaml"
    cfg.write_text(f"roots:\n  - {root}\n", encoding="utf-8")
    monkeypatch.setattr("planctl.config.CONFIG_PATH", cfg)


def _invoke(args: list[str]) -> tuple[int, dict | None, str]:
    runner = CliRunner()
    result = runner.invoke(cli, args)
    obj = _first_envelope(result.output)
    return result.exit_code, obj, result.output


def _first_envelope(output: str) -> dict | None:
    """Return the first JSON object in *output* that is NOT a bare
    planctl_invocation envelope. Tolerates compact and pretty-printed JSON.
    Copied from ``tests/test_resolve_task.py``.
    """
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


def _seed_commit(repo, task_id: str, *, body: str | None = None) -> str:
    """Create an empty commit in *repo* carrying a `Task: <task_id>` trailer.

    Returns the full SHA. The message body defaults to a real trailer; pass
    `body` to seed a prose false-match (no real trailer). Copied from
    ``tests/test_close_preflight.py``.
    """
    msg = body if body is not None else f"feat: work\n\nTask: {task_id}\n"
    subprocess.run(
        ["git", "commit", "--allow-empty", "-F", "-"],
        input=msg,
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    )
    sha = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    )
    return sha.stdout.strip()


def _make_epic_with_task(n_tasks: int = 1):
    from pathlib import Path

    from .conftest import seed_epic

    epic_id, task_ids = seed_epic(Path.cwd(), title="FTC epic", n_tasks=n_tasks)
    return epic_id, task_ids


# ---------------------------------------------------------------------------
# Single-task happy path: a real Task:-trailer commit flattens to commits:[{...}]
# ---------------------------------------------------------------------------


def test_find_task_commit_happy_path(planctl_git_repo):
    """A real `Task:`-trailer commit yields the flat keeper-compatible envelope."""
    _, task_ids = _make_epic_with_task()
    task_id = task_ids[0]
    sha = _seed_commit(planctl_git_repo, task_id)

    code, obj, output = _invoke(["find-task-commit", task_id])
    assert code == 0, output
    assert obj is not None
    assert obj.get("success") is True
    assert obj.get("commits") == [{"sha": sha, "repo": str(planctl_git_repo.resolve())}]
    # Field names + full %H, not sha256 / repo_path.
    commit = obj["commits"][0]
    assert set(commit.keys()) == {"sha", "repo"}
    assert len(commit["sha"]) == 40
    assert commit["repo"].startswith("/")


def test_find_task_commit_flatten_order(planctl_git_repo):
    """Two trailer commits for the SAME task in primary flatten in grep order.

    The scan set is `[primary_repo]`, so both SHAs land in one group and flatten
    to two `commits` entries preserving per-repo grep order. `git log --grep`
    returns newest-first, so the flattened order is `[newer, older]`.
    """
    _, task_ids = _make_epic_with_task()
    task_id = task_ids[0]
    sha_older = _seed_commit(planctl_git_repo, task_id)
    sha_newer = _seed_commit(planctl_git_repo, task_id)

    code, obj, output = _invoke(["find-task-commit", task_id])
    assert code == 0, output
    assert obj is not None
    repo = str(planctl_git_repo.resolve())
    # git log --grep emits newest-first; the wrapper preserves that grep order.
    assert obj.get("commits") == [
        {"sha": sha_newer, "repo": repo},
        {"sha": sha_older, "repo": repo},
    ]


# ---------------------------------------------------------------------------
# Clean miss → empty success exit 0 (NEVER an error)
# ---------------------------------------------------------------------------


def test_find_task_commit_clean_miss_empty_success(planctl_git_repo):
    """No commit carries the task's trailer → commits: [], success, exit 0."""
    _, task_ids = _make_epic_with_task()
    task_id = task_ids[0]

    code, obj, output = _invoke(["find-task-commit", task_id])
    assert code == 0, output
    assert obj is not None
    assert obj.get("success") is True
    assert obj.get("commits") == []


def test_find_task_commit_prose_false_match_dropped(planctl_git_repo):
    """A prose `Task:` mention the -F grep catches is dropped by the post-filter."""
    _, task_ids = _make_epic_with_task()
    task_id = task_ids[0]
    _seed_commit(
        planctl_git_repo,
        task_id,
        body=f"chore: note\n\nfixes the Task: {task_id} issue in prose\n",
    )

    code, obj, output = _invoke(["find-task-commit", task_id])
    assert code == 0, output
    assert obj is not None
    assert obj.get("commits") == []


# ---------------------------------------------------------------------------
# AllReposBrokenError → COMMIT_LOOKUP_FAILED + details.broken_repos, exit 1
# ---------------------------------------------------------------------------


def test_find_task_commit_all_repos_broken(
    planctl_git_repo, monkeypatch, tmp_path_factory
):
    """Every repo in touched_repos missing/non-git → COMMIT_LOOKUP_FAILED, exit 1.

    Patch `planctl.store.load_json` (the symbol `run()` re-imports at call time)
    so the epic record carries a `touched_repos` pointing only at a non-git dir,
    making the scan set all-broken. The broken dir comes from `tmp_path_factory`
    so it lives OUTSIDE the project's git tree — otherwise `git rev-parse` walks
    up to the project's `.git` and treats the subdir as a usable repo.
    """
    import planctl.store as _store

    _, task_ids = _make_epic_with_task()
    task_id = task_ids[0]
    broken = tmp_path_factory.mktemp("ftc_not_a_repo")
    real_load_json = _store.load_json

    def _fake_load_json(path):
        data = real_load_json(path)
        if isinstance(data, dict) and "epics" in str(path):
            data["touched_repos"] = [str(broken)]
        return data

    monkeypatch.setattr(_store, "load_json", _fake_load_json)

    code, obj, output = _invoke(["find-task-commit", task_id])
    assert code != 0, output
    assert obj is not None
    assert obj.get("success") is False
    assert obj.get("error", {}).get("code") == "COMMIT_LOOKUP_FAILED"
    assert obj["error"].get("details", {}).get("broken_repos") == [str(broken)]


# ---------------------------------------------------------------------------
# Typed input / resolution errors
# ---------------------------------------------------------------------------


def test_find_task_commit_bad_id(planctl_git_repo):
    """A malformed (non-task) id returns BAD_TASK_ID, exit 1."""
    code, obj, output = _invoke(["find-task-commit", "not-a-task-id"])
    assert code != 0, output
    assert obj is not None
    assert obj.get("success") is False
    assert obj.get("error", {}).get("code") == "BAD_TASK_ID"


def test_find_task_commit_epic_id_is_bad_task_id(planctl_git_repo):
    """An epic id (no `.M`) is not a task id → BAD_TASK_ID."""
    code, obj, output = _invoke(["find-task-commit", "fn-1-foo"])
    assert code != 0, output
    assert obj is not None
    assert obj.get("error", {}).get("code") == "BAD_TASK_ID"


def test_find_task_commit_not_found(planctl_git_repo):
    """A well-formed id with no matching project returns TASK_NOT_FOUND."""
    code, obj, output = _invoke(["find-task-commit", "fn-9999-no-task.1"])
    assert code != 0, output
    assert obj is not None
    assert obj.get("error", {}).get("code") == "TASK_NOT_FOUND"


# ---------------------------------------------------------------------------
# --project resolution across a two-project collision
# ---------------------------------------------------------------------------


def _make_two_projects_with_same_task(tmp_path, monkeypatch):
    """Seed two sibling projects under a shared root, both holding the same task id.

    Mirrors ``tests/test_resolve_task.py::_make_two_projects_with_same_task``.
    Overrides the autouse CONFIG_PATH so discovery surfaces both as candidates.
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

    cfg = tmp_path / "_ambiguous_roots_config.yaml"
    cfg.write_text(f"roots:\n  - {root}\n", encoding="utf-8")
    monkeypatch.setattr("planctl.config.CONFIG_PATH", cfg)

    return proj_a, proj_b, task_id


def test_find_task_commit_ambiguous(tmp_path, monkeypatch):
    """Same task id in two projects under the roots → AMBIGUOUS_TASK_ID."""
    proj_a, proj_b, task_id = _make_two_projects_with_same_task(tmp_path, monkeypatch)

    code, obj, output = _invoke(["find-task-commit", task_id])
    assert code != 0, output
    assert obj is not None
    assert obj.get("error", {}).get("code") == "AMBIGUOUS_TASK_ID"
    candidates = obj["error"].get("details", {}).get("candidates", [])
    assert len(candidates) == 2
    assert str(proj_a) in candidates
    assert str(proj_b) in candidates


def test_find_task_commit_project_disambiguates(tmp_path, monkeypatch):
    """--project <path> bypasses the AMBIGUOUS_TASK_ID error and resolves cleanly.

    A bare `find-task-commit <task_id>` over the colliding pair raises
    AMBIGUOUS_TASK_ID (asserted above); passing `--project <abs>` for either
    project resolves to exit 0. Both projects' epic records pin the scan set at
    proj_a (proj_b's epic JSON is a copy of proj_a's, carrying proj_a's resolved
    `primary_repo`/`touched_repos`), so the trailer commit seeded into proj_a is
    found via either `--project`.
    """
    proj_a, proj_b, task_id = _make_two_projects_with_same_task(tmp_path, monkeypatch)
    sha = _seed_commit(proj_a, task_id)
    expected = [{"sha": sha, "repo": str(proj_a.resolve())}]

    code, obj, output = _invoke(["find-task-commit", task_id, "--project", str(proj_a)])
    assert code == 0, output
    assert obj is not None
    assert obj.get("commits") == expected

    code, obj, output = _invoke(["find-task-commit", task_id, "--project", str(proj_b)])
    assert code == 0, output
    assert obj is not None
    assert obj.get("commits") == expected


def test_find_task_commit_project_not_a_project(planctl_git_repo, tmp_path):
    """--project <path> with no .planctl/ returns NOT_A_PROJECT."""
    not_a_proj = tmp_path / "_not_a_planctl_proj"
    not_a_proj.mkdir()

    code, obj, output = _invoke(
        ["find-task-commit", "fn-1-foo.1", "--project", str(not_a_proj)]
    )
    assert code != 0, output
    assert obj is not None
    assert obj.get("error", {}).get("code") == "NOT_A_PROJECT"


# ---------------------------------------------------------------------------
# Read-only contract: no chore(planctl): commit lands
# ---------------------------------------------------------------------------


def test_find_task_commit_lands_no_commit(planctl_git_repo):
    """find-task-commit is read-only — no `chore(planctl): find-task-commit` commit."""
    _, task_ids = _make_epic_with_task()
    task_id = task_ids[0]
    _seed_commit(planctl_git_repo, task_id)

    head_before = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=planctl_git_repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()

    code, obj, output = _invoke(["find-task-commit", task_id])
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
        "find-task-commit is read-only; a chore(planctl): commit should not land"
    )

    log = subprocess.run(
        ["git", "log", "-5", "--pretty=%s"],
        cwd=planctl_git_repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    assert "find-task-commit" not in log, (
        f"Found a find-task-commit commit subject in recent history:\n{log}"
    )


# ---------------------------------------------------------------------------
# Envelope carries the readonly planctl_invocation footer
# ---------------------------------------------------------------------------


def test_find_task_commit_envelope_carries_readonly_invocation(planctl_git_repo):
    """The envelope's planctl_invocation has op=find-task-commit, NULL files/subject."""
    _, task_ids = _make_epic_with_task()
    task_id = task_ids[0]

    runner = CliRunner()
    result = runner.invoke(cli, ["find-task-commit", task_id])
    assert result.exit_code == 0, result.output

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
    assert invocation_obj.get("op") == "find-task-commit"
    assert invocation_obj.get("subject") is None
    assert invocation_obj.get("files") is None
