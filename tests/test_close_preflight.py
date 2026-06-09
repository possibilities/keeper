"""Tests for the read-only `planctl close-preflight <epic_id>` verb (fn-565).

The verb wraps the /plan:close Phase 0a/2 fetch behind one envelope:
``{primary_repo, tasks, all_done, commit_groups, snippet_context}``. `commit_groups`
is assembled in-process by a native `git log --grep` + `interpret-trailers --parse`
trailer scan (`planctl.commit_lookup`); `snippet_context` shells
`promptctl render-spec`. The render shell-out is monkeypatched via the module-level
`subprocess.run` so the tests stay hermetic; the commit scan runs against real git
commits (the `project` fixture git-inits the project root, so `primary_repo` is a
real repo) under the autouse hermetic git config.

Coverage (per the task's Test notes):
- all_done true / false
- empty commit set → commit_groups: []
- native scan groups real Task:-trailer commits by repo (first-seen order)
- all-repos-broken → fail-loud typed COMMIT_LOOKUP_FAILED (details.broken_repos)
- empty render → snippet_context: ""
- bad / missing epic id → typed error
- direct `commit_lookup.find_commit_groups` unit coverage (tri-state, post-filter,
  is_task_id gate, multi-valued keys, SHA dedup)
"""

from __future__ import annotations

import json
import subprocess
from types import SimpleNamespace

import pytest
from click.testing import CliRunner
from planctl import run_close_preflight
from planctl.cli import cli
from planctl.commit_lookup import AllReposBrokenError, find_commit_groups

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


_TASK_SPEC = (
    "## Description\nx\n\n## Acceptance\n- [ ] x\n\n## Done summary\n\n## Evidence\n"
)


def _make_epic(project, *, statuses):
    """Scaffold an epic + N tasks, then drive the given runtime statuses.

    Returns ``(epic_id, task_ids)`` — the scaffold-minted epic id and its
    ordinal task ids. `statuses[i]` of "done" claims + completes task i; any
    other value leaves it `todo`. Uses the planctl CLI so the on-disk JSON
    shape matches production exactly.
    """
    runner = CliRunner()
    tasks_yaml = "\n".join(
        f"  - title: task {i}\n    tier: medium\n    spec: |\n"
        + "\n".join("      " + ln for ln in _TASK_SPEC.splitlines())
        for i in range(1, len(statuses) + 1)
    )
    yaml = (
        "epic:\n  title: Demo epic\n  spec: |\n    ## Overview\n    demo\ntasks:\n"
        + tasks_yaml
        + "\n"
    )
    plan_path = project / "plan.yaml"
    plan_path.write_text(yaml, encoding="utf-8")

    r = runner.invoke(cli, ["scaffold", "--file", str(plan_path)])
    assert r.exit_code == 0, r.output
    env = _envelope(r.output)
    epic_id = env["epic_id"]
    task_ids = env["task_ids"]

    for tid, status in zip(task_ids, statuses, strict=True):
        if status == "done":
            # `done --force` skips the in_progress precondition, so flip
            # todo→done in one call (avoids `claim`, which shells a real
            # promptctl render-spec that can't resolve a throwaway project).
            r = runner.invoke(cli, ["done", tid, "--summary", "done", "--force"])
            assert r.exit_code == 0, r.output
    return epic_id, task_ids


def _fake_render(*, render_stdout="", render_rc=0):
    """Build a fake `subprocess.run` that stubs only `promptctl render-spec`.

    The native commit-trailer scan in `planctl.commit_lookup` uses its own
    `subprocess` binding (not patched here), so it runs against real git; this
    fake only intercepts the read-only render shell-out so close-preflight's
    snippet fetch stays hermetic. Any other command passes through to real
    `subprocess.run`.
    """
    real_run = subprocess.run

    def _run(cmd, *args, **kwargs):
        if cmd[:2] == ["promptctl", "render-spec"]:
            return subprocess.CompletedProcess(
                cmd, render_rc, stdout=render_stdout, stderr="rerr"
            )
        return real_run(cmd, *args, **kwargs)

    return _run


def _seed_commit(repo, task_id: str, *, body: str | None = None) -> str:
    """Create an empty commit in *repo* carrying a `Task: <task_id>` trailer.

    Returns the full SHA. The message body defaults to a real trailer; pass
    `body` to seed a prose false-match (no real trailer) or a custom message.
    Uses `--allow-empty` so no worktree files are needed.
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


def _envelope(output: str) -> dict:
    """Parse the primary envelope, skipping a *pure* read-only invocation line.

    Mutating verbs (scaffold) emit one compact object carrying BOTH the payload
    keys AND `planctl_invocation`; read-only verbs (close-preflight success)
    emit the payload first, then a separate trailing `{planctl_invocation: ...}`
    line. Return the first object carrying a payload key (`success`, `error`,
    `primary_repo`, `epic_id`), so both shapes resolve correctly.
    """
    payload_keys = ("success", "error", "primary_repo", "epic_id")
    decoder = json.JSONDecoder()
    idx = 0
    while idx < len(output):
        brace = output.find("{", idx)
        if brace == -1:
            break
        try:
            obj, end = decoder.raw_decode(output, brace)
        except json.JSONDecodeError:
            idx = brace + 1
            continue
        if any(k in obj for k in payload_keys):
            return obj
        idx = end
    raise AssertionError(f"no envelope found in {output!r}")


# ---------------------------------------------------------------------------
# all_done true / false
# ---------------------------------------------------------------------------


class TestAllDone:
    def test_all_done_true(self, project, monkeypatch):
        epic_id, task_ids = _make_epic(project, statuses=["done", "done"])
        monkeypatch.setattr(run_close_preflight.subprocess, "run", _fake_render())
        r = CliRunner().invoke(cli, ["close-preflight", epic_id])
        assert r.exit_code == 0, r.output
        env = _envelope(r.output)
        assert env["all_done"] is True
        assert [t["status"] for t in env["tasks"]] == ["done", "done"]
        assert [t["id"] for t in env["tasks"]] == task_ids

    def test_all_done_false(self, project, monkeypatch):
        epic_id, _ = _make_epic(project, statuses=["done", "todo"])
        monkeypatch.setattr(run_close_preflight.subprocess, "run", _fake_render())
        r = CliRunner().invoke(cli, ["close-preflight", epic_id])
        assert r.exit_code == 0, r.output
        env = _envelope(r.output)
        assert env["all_done"] is False


# ---------------------------------------------------------------------------
# commit_groups
# ---------------------------------------------------------------------------


class TestCommitGroups:
    def test_empty_commit_set(self, project, monkeypatch):
        epic_id, _ = _make_epic(project, statuses=["done"])
        monkeypatch.setattr(run_close_preflight.subprocess, "run", _fake_render())
        r = CliRunner().invoke(cli, ["close-preflight", epic_id])
        assert r.exit_code == 0, r.output
        env = _envelope(r.output)
        assert env["commit_groups"] == []

    def test_groups_real_commits_in_primary_repo(self, project, monkeypatch):
        """Native scan finds both tasks' real Task:-trailer commits in primary_repo.

        With no `touched_repos`, the scan set is `[primary_repo]` (the project
        root, git-inited by the fixture). Seed one real commit per task; the
        single-repo group collects both SHAs in commit order.
        """
        epic_id, task_ids = _make_epic(project, statuses=["done", "done"])
        sha0 = _seed_commit(project, task_ids[0])
        sha1 = _seed_commit(project, task_ids[1])
        monkeypatch.setattr(run_close_preflight.subprocess, "run", _fake_render())
        r = CliRunner().invoke(cli, ["close-preflight", epic_id])
        assert r.exit_code == 0, r.output
        env = _envelope(r.output)
        primary = str(project.resolve())
        assert env["commit_groups"] == [{"repo": primary, "shas": [sha0, sha1]}]

    def test_prose_false_match_is_dropped(self, project, monkeypatch):
        """A prose `Task:` mention the -F grep catches is dropped by the post-filter."""
        epic_id, task_ids = _make_epic(project, statuses=["done"])
        # Prose body: the cheap grep pre-filter matches, interpret-trailers does not.
        _seed_commit(
            project,
            task_ids[0],
            body=f"chore: note\n\nfixes the Task: {task_ids[0]} issue in prose\n",
        )
        monkeypatch.setattr(run_close_preflight.subprocess, "run", _fake_render())
        r = CliRunner().invoke(cli, ["close-preflight", epic_id])
        assert r.exit_code == 0, r.output
        env = _envelope(r.output)
        assert env["commit_groups"] == []

    def test_all_repos_broken_is_fail_loud(
        self, project, monkeypatch, tmp_path_factory
    ):
        """Every repo in touched_repos missing/non-git → COMMIT_LOOKUP_FAILED.

        Patch `planctl.api.load_epic` (the symbol `run()` re-imports at call
        time) to inject a `touched_repos` pointing only at a non-git dir, so the
        scan set is all-broken and the verb fails loud with the
        `details.broken_repos` shape. The broken dir lives OUTSIDE the project's
        git tree so `git rev-parse` cannot resolve a parent `.git`.
        """
        import planctl.api as _api

        epic_id, _ = _make_epic(project, statuses=["done"])
        broken = tmp_path_factory.mktemp("not-a-repo")
        real_load_epic = _api.load_epic

        def _fake_load_epic(ctx, eid):
            data = real_load_epic(ctx, eid)
            data["touched_repos"] = [str(broken)]
            return data

        monkeypatch.setattr(_api, "load_epic", _fake_load_epic)
        monkeypatch.setattr(run_close_preflight.subprocess, "run", _fake_render())
        r = CliRunner().invoke(cli, ["close-preflight", epic_id])
        assert r.exit_code == 1, r.output
        env = _envelope(r.output)
        assert env["success"] is False
        assert env["error"]["code"] == "COMMIT_LOOKUP_FAILED"
        from pathlib import Path as _Path

        assert env["error"]["details"]["broken_repos"] == [
            str(_Path(str(broken)).resolve())
        ]


# ---------------------------------------------------------------------------
# snippet_context
# ---------------------------------------------------------------------------


class TestSnippetContext:
    def test_empty_render(self, project, monkeypatch):
        epic_id, _ = _make_epic(project, statuses=["done"])
        monkeypatch.setattr(
            run_close_preflight.subprocess,
            "run",
            _fake_render(render_stdout=""),
        )
        r = CliRunner().invoke(cli, ["close-preflight", epic_id])
        assert r.exit_code == 0, r.output
        env = _envelope(r.output)
        assert env["snippet_context"] == ""

    def test_render_passthrough(self, project, monkeypatch):
        epic_id, _ = _make_epic(project, statuses=["done"])
        monkeypatch.setattr(
            run_close_preflight.subprocess,
            "run",
            _fake_render(render_stdout="## ctx\nhello"),
        )
        r = CliRunner().invoke(cli, ["close-preflight", epic_id])
        assert r.exit_code == 0, r.output
        env = _envelope(r.output)
        assert env["snippet_context"] == "## ctx\nhello"

    def test_render_failure_is_fail_loud(self, project, monkeypatch):
        epic_id, _ = _make_epic(project, statuses=["done"])
        monkeypatch.setattr(
            run_close_preflight.subprocess,
            "run",
            _fake_render(render_rc=2),
        )
        r = CliRunner().invoke(cli, ["close-preflight", epic_id])
        assert r.exit_code == 1, r.output
        env = _envelope(r.output)
        assert env["success"] is False
        assert env["error"]["code"] == "SNIPPET_RENDER_FAILED"


# ---------------------------------------------------------------------------
# id / existence gates
# ---------------------------------------------------------------------------


class TestGates:
    def test_bad_epic_id(self, project):
        r = CliRunner().invoke(cli, ["close-preflight", "not-an-id"])
        assert r.exit_code == 1, r.output
        env = _envelope(r.output)
        assert env["error"]["code"] == "BAD_EPIC_ID"

    def test_epic_not_found(self, project):
        r = CliRunner().invoke(cli, ["close-preflight", "fn-99-missing"])
        assert r.exit_code == 1, r.output
        env = _envelope(r.output)
        assert env["error"]["code"] == "EPIC_NOT_FOUND"


def test_run_directly_no_click_context(project, monkeypatch):
    """run() tolerates being called without a live click context (sentinel no-op)."""
    epic_id, _ = _make_epic(project, statuses=["done"])
    monkeypatch.setattr(run_close_preflight.subprocess, "run", _fake_render())
    # Direct call — the error path's sentinel set is a no-op without a context.
    rc = run_close_preflight.run(SimpleNamespace(epic_id=epic_id))
    assert rc == 0


# ---------------------------------------------------------------------------
# fn-589 task .1 (item 4): --project <abs_path> bypasses cwd-walk
# ---------------------------------------------------------------------------


class TestProjectFlag:
    def test_project_resolves_from_outside_cwd(self, project, monkeypatch, tmp_path):
        """`--project <abs>` resolves the project even when cwd is elsewhere."""
        import os

        epic_id, _ = _make_epic(project, statuses=["done"])
        monkeypatch.setattr(run_close_preflight.subprocess, "run", _fake_render())

        # chdir away from the planctl project so resolve_project() would fail.
        outside = tmp_path / "outside-the-project"
        outside.mkdir()
        os.chdir(outside)

        r = CliRunner().invoke(
            cli, ["close-preflight", epic_id, "--project", str(project)]
        )
        assert r.exit_code == 0, r.output
        env = _envelope(r.output)
        assert env["success"] is True
        assert "tasks" in env

    def test_project_relative_raises_usage_error(self, project):
        """Relative paths under `--project` raise a click UsageError (exit 2)."""
        r = CliRunner().invoke(
            cli, ["close-preflight", "fn-1-bogus", "--project", "relative/path"]
        )
        # click UsageError exits with code 2 by default.
        assert r.exit_code == 2, r.output
        assert "absolute path" in r.output

    def test_project_unset_falls_back_to_cwd_walk(self, project, monkeypatch):
        """Without `--project`, behavior is unchanged (cwd-walk via resolve_project)."""
        epic_id, _ = _make_epic(project, statuses=["done"])
        monkeypatch.setattr(run_close_preflight.subprocess, "run", _fake_render())
        r = CliRunner().invoke(cli, ["close-preflight", epic_id])
        assert r.exit_code == 0, r.output
        env = _envelope(r.output)
        assert env["success"] is True


# ---------------------------------------------------------------------------
# Direct unit coverage for planctl.commit_lookup.find_commit_groups — the
# verb-agnostic seam fn-6's run_reconcile imports. Exercises the trailer
# post-filter, is_task_id gate, multi-valued keys, SHA dedup, and the
# touched_repos tri-state against real git repos (hermetic via the autouse
# git config).
# ---------------------------------------------------------------------------


def _git_repo(path):
    """git init *path* and return it as an absolute-path string."""
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init"], cwd=path, check=True, capture_output=True)
    return str(path.resolve())


class TestCommitLookup:
    def test_clean_miss_returns_empty(self, tmp_path):
        repo = _git_repo(tmp_path / "r")
        _seed_commit(repo, "fn-1-foo.1")  # not the queried task
        groups = find_commit_groups(["fn-1-foo.2"], repo, None)
        assert groups == []

    def test_prose_false_match_dropped_by_post_filter(self, tmp_path):
        repo = _git_repo(tmp_path / "r")
        _seed_commit(
            repo,
            "fn-1-foo.1",
            body="chore: x\n\nmentions Task: fn-1-foo.1 only in prose\n",
        )
        assert find_commit_groups(["fn-1-foo.1"], repo, None) == []

    def test_is_task_id_rejected_trailer_value_dropped(self, tmp_path):
        repo = _git_repo(tmp_path / "r")
        # A real trailer whose value is an epic id (not a task id): is_task_id
        # rejects it, so even a confirmed trailer never matches a task query.
        _seed_commit(repo, "fn-1-foo", body="feat: x\n\nTask: fn-1-foo\n")
        assert find_commit_groups(["fn-1-foo"], repo, None) == []

    def test_multi_valued_task_keys(self, tmp_path):
        repo = _git_repo(tmp_path / "r")
        # One commit carrying two Task: trailers; each task query finds it.
        sha = _seed_commit(
            repo,
            "fn-1-foo.1",
            body="feat: x\n\nTask: fn-1-foo.1\nTask: fn-1-foo.2\n",
        )
        groups = find_commit_groups(["fn-1-foo.1", "fn-1-foo.2"], repo, None)
        # Single repo group; the shared SHA appears once per repo (deduped),
        # but both task queries confirm it → two entries unless deduped.
        assert groups == [{"repo": repo, "shas": [sha]}]

    def test_sha_dedup_within_repo(self, tmp_path):
        repo = _git_repo(tmp_path / "r")
        sha = _seed_commit(
            repo,
            "fn-1-foo.1",
            body="feat: x\n\nTask: fn-1-foo.1\nTask: fn-1-foo.1\n",
        )
        # Duplicate trailer for the SAME task on one commit → one SHA, deduped.
        groups = find_commit_groups(["fn-1-foo.1"], repo, None)
        assert groups == [{"repo": repo, "shas": [sha]}]

    def test_touched_repos_none_scans_primary(self, tmp_path):
        primary = _git_repo(tmp_path / "primary")
        sha = _seed_commit(primary, "fn-1-foo.1")
        groups = find_commit_groups(["fn-1-foo.1"], primary, None)
        assert groups == [{"repo": primary, "shas": [sha]}]

    def test_touched_repos_empty_scans_nothing(self, tmp_path):
        primary = _git_repo(tmp_path / "primary")
        _seed_commit(primary, "fn-1-foo.1")
        # [] means "scan nothing" — must NOT collapse to primary_repo.
        assert find_commit_groups(["fn-1-foo.1"], primary, []) == []

    def test_touched_repos_first_seen_order(self, tmp_path):
        # Repo-outer first-seen order = touched_repos order, NOT discovery order.
        repo_b = _git_repo(tmp_path / "b")
        repo_a = _git_repo(tmp_path / "a")
        sha_b = _seed_commit(repo_b, "fn-1-foo.1")
        sha_a = _seed_commit(repo_a, "fn-1-foo.1")
        # touched_repos lists b before a; the result must too.
        groups = find_commit_groups(["fn-1-foo.1"], repo_a, [repo_b, repo_a])
        assert groups == [
            {"repo": repo_b, "shas": [sha_b]},
            {"repo": repo_a, "shas": [sha_a]},
        ]

    def test_one_broken_repo_is_skipped(self, tmp_path):
        good = _git_repo(tmp_path / "good")
        broken = tmp_path / "broken"  # exists but not a git repo
        broken.mkdir()
        sha = _seed_commit(good, "fn-1-foo.1")
        # One broken entry is skipped with a stderr note; the good repo still
        # yields its group (no raise — at least one usable repo).
        groups = find_commit_groups(["fn-1-foo.1"], good, [str(broken), good])
        assert groups == [{"repo": good, "shas": [sha]}]

    def test_all_repos_broken_raises(self, tmp_path):
        missing = tmp_path / "missing"  # does not exist
        not_git = tmp_path / "not-git"
        not_git.mkdir()
        with pytest.raises(AllReposBrokenError) as exc:
            find_commit_groups(
                ["fn-1-foo.1"], str(missing), [str(missing), str(not_git)]
            )
        assert exc.value.broken_repos == [
            str(missing.resolve()),
            str(not_git.resolve()),
        ]
