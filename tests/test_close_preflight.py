"""Tests for the read-only `planctl close-preflight <epic_id>` verb (fn-565).

The verb wraps the /plan:close Phase 0a/2 fetch behind one envelope:
``{primary_repo, tasks, all_done, commit_groups, snippet_context}``. It shells
`jobctl find-task-commit` per task (grouped by repo, fail-loud) and
`promptctl render-spec` for the snippet context — both are monkeypatched here
via the module-level `subprocess.run` so the tests stay hermetic.

Coverage (per the task's Test notes):
- all_done true / false
- empty commit set → commit_groups: []
- jobctl failure → fail-loud typed COMMIT_LOOKUP_FAILED error (exit 1)
- empty render → snippet_context: ""
- bad / missing epic id → typed error
"""

from __future__ import annotations

import json
import subprocess
from types import SimpleNamespace

from click.testing import CliRunner
from planctl import run_close_preflight
from planctl.cli import cli

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


def _fake_invoke(
    *, commits_by_task=None, commit_fail_task=None, render_stdout="", render_rc=0
):
    """Build a fake `subprocess.run` dispatching on the shelled command.

    - `jobctl find-task-commit <tid>` → CompletedProcess with a `{commits:[...]}`
      JSON stdout (from `commits_by_task[tid]`), or rc=1 when tid == commit_fail_task.
    - `promptctl render-spec ...` → CompletedProcess with `render_stdout` / `render_rc`.
    """
    commits_by_task = commits_by_task or {}
    real_run = subprocess.run

    def _run(cmd, *args, **kwargs):
        if cmd[:2] == ["jobctl", "find-task-commit"]:
            tid = cmd[2]
            if tid == commit_fail_task:
                return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="boom")
            payload = {"commits": commits_by_task.get(tid, [])}
            return subprocess.CompletedProcess(
                cmd, 0, stdout=json.dumps(payload), stderr=""
            )
        if cmd[:2] == ["promptctl", "render-spec"]:
            return subprocess.CompletedProcess(
                cmd, render_rc, stdout=render_stdout, stderr="rerr"
            )
        return real_run(cmd, *args, **kwargs)

    return _run


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
        monkeypatch.setattr(
            run_close_preflight.subprocess, "run", _fake_invoke(commits_by_task={})
        )
        r = CliRunner().invoke(cli, ["close-preflight", epic_id])
        assert r.exit_code == 0, r.output
        env = _envelope(r.output)
        assert env["all_done"] is True
        assert [t["status"] for t in env["tasks"]] == ["done", "done"]
        assert [t["id"] for t in env["tasks"]] == task_ids

    def test_all_done_false(self, project, monkeypatch):
        epic_id, _ = _make_epic(project, statuses=["done", "todo"])
        monkeypatch.setattr(
            run_close_preflight.subprocess, "run", _fake_invoke(commits_by_task={})
        )
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
        monkeypatch.setattr(
            run_close_preflight.subprocess, "run", _fake_invoke(commits_by_task={})
        )
        r = CliRunner().invoke(cli, ["close-preflight", epic_id])
        assert r.exit_code == 0, r.output
        env = _envelope(r.output)
        assert env["commit_groups"] == []

    def test_groups_by_repo(self, project, monkeypatch):
        epic_id, task_ids = _make_epic(project, statuses=["done", "done"])
        commits = {
            task_ids[0]: [
                {"repo": "/r/a", "sha": "aaa"},
                {"repo": "/r/b", "sha": "bbb"},
            ],
            task_ids[1]: [{"repo": "/r/a", "sha": "ccc"}],
        }
        monkeypatch.setattr(
            run_close_preflight.subprocess, "run", _fake_invoke(commits_by_task=commits)
        )
        r = CliRunner().invoke(cli, ["close-preflight", epic_id])
        assert r.exit_code == 0, r.output
        env = _envelope(r.output)
        # First-seen repo order: /r/a then /r/b.
        assert env["commit_groups"] == [
            {"repo": "/r/a", "shas": ["aaa", "ccc"]},
            {"repo": "/r/b", "shas": ["bbb"]},
        ]

    def test_jobctl_failure_is_fail_loud(self, project, monkeypatch):
        epic_id, task_ids = _make_epic(project, statuses=["done"])
        monkeypatch.setattr(
            run_close_preflight.subprocess,
            "run",
            _fake_invoke(commit_fail_task=task_ids[0]),
        )
        r = CliRunner().invoke(cli, ["close-preflight", epic_id])
        assert r.exit_code == 1, r.output
        env = _envelope(r.output)
        assert env["success"] is False
        assert env["error"]["code"] == "COMMIT_LOOKUP_FAILED"
        assert env["error"]["details"]["task_id"] == task_ids[0]


# ---------------------------------------------------------------------------
# snippet_context
# ---------------------------------------------------------------------------


class TestSnippetContext:
    def test_empty_render(self, project, monkeypatch):
        epic_id, _ = _make_epic(project, statuses=["done"])
        monkeypatch.setattr(
            run_close_preflight.subprocess,
            "run",
            _fake_invoke(commits_by_task={}, render_stdout=""),
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
            _fake_invoke(commits_by_task={}, render_stdout="## ctx\nhello"),
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
            _fake_invoke(commits_by_task={}, render_rc=2),
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
    monkeypatch.setattr(
        run_close_preflight.subprocess, "run", _fake_invoke(commits_by_task={})
    )
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
        monkeypatch.setattr(
            run_close_preflight.subprocess, "run", _fake_invoke(commits_by_task={})
        )

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
        monkeypatch.setattr(
            run_close_preflight.subprocess, "run", _fake_invoke(commits_by_task={})
        )
        r = CliRunner().invoke(cli, ["close-preflight", epic_id])
        assert r.exit_code == 0, r.output
        env = _envelope(r.output)
        assert env["success"] is True
