"""Engine-agnostic conformance spec for the three worker-loop mutating verbs.

``claim`` / ``done`` / ``block`` — the executable spec the ``planctl-bun`` port
targets for its first writes. Every fixture is seeded with the CLI-free
``seed_state`` disk builder + ``monkeypatch.chdir`` (the
``tests/test_session_markers.py`` seeding shape), never ``seed_epic`` /
``scaffold`` (the bun binary implements no scaffold). Under conformance only the
verb-under-test crosses the ``PLANCTL_BIN`` subprocess boundary.

What is pinned, per the wave's central commit/no-commit split:

* ``claim`` success envelope fields + runtime state read back off the
  ``.planctl/state/`` file.
* ``claim`` typed error envelopes and the ``--force`` matrix: ``TASK_DONE`` is
  never bypassed; ``CLAIMED_BY_OTHER`` / ``TASK_BLOCKED`` / ``DEPS_UNMET`` are.
* ``claim`` and ``block`` produce ZERO commits (git rev-list count delta).
* ``block`` sets ``blocked`` + ``blocked_reason`` and clears them on disk.
* ``done`` under frozen ``PLANCTL_NOW`` + a session id: spec sections patched,
  ``worker_done_at`` stamped on the tracked task JSON equal to the frozen value,
  exactly one commit whose subject is ``chore(planctl): done <task_id>`` and
  whose body carries the Planctl-Op / Planctl-Target / Planctl-Prev-Op (+
  Session-Id) trailers.
* Session-id polarity: ``done`` without ``CLAUDE_CODE_SESSION_ID`` hard-errors
  (fail-closed) while ``claim`` succeeds without it (fail-open).

Assertions are on envelopes, ``.planctl/`` files, and git log — never on Python
internals. Commit-asserting tests carry ``real_git`` so the default engine
exercises the real auto-commit honestly; under conformance everything is real
git anyway.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from .conftest import parse_cli_output, run_cli, seed_state

_SID = {"CLAUDE_CODE_SESSION_ID": "test-worker-verbs"}


# ---------------------------------------------------------------------------
# Helpers — disk + git, no Python internals.
# ---------------------------------------------------------------------------


def _runtime(tmp_path: Path, task_id: str) -> dict | None:
    """Read a task's runtime state straight off the gitignored state file."""
    p = tmp_path / ".planctl" / "state" / "tasks" / f"{task_id}.state.json"
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def _task_def(tmp_path: Path, task_id: str) -> dict:
    """Read a task's tracked definition JSON."""
    p = tmp_path / ".planctl" / "tasks" / f"{task_id}.json"
    return json.loads(p.read_text(encoding="utf-8"))


def _write_runtime(tmp_path: Path, task_id: str, state: dict) -> None:
    """Seed a runtime-state overlay file directly (no verb, no lock)."""
    d = tmp_path / ".planctl" / "state" / "tasks"
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{task_id}.state.json"
    p.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _git(args: list[str], cwd: Path) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=True
    ).stdout


def _commit_count(repo: Path) -> int:
    return int(_git(["rev-list", "--count", "HEAD"], repo).strip())


def _head_message(repo: Path) -> str:
    return _git(["log", "-1", "--format=%B"], repo).strip()


def _git_seed(tmp_path: Path) -> None:
    """Turn a ``seed_state`` tree into a clean git baseline.

    ``git init`` + commit the seeded ``.planctl/`` tree so any later dirty state
    is attributable to the verb under test. Identity / gpgsign / hooksPath ride
    the session-scoped ``GIT_CONFIG_GLOBAL`` set by ``_git_global_config``.
    """
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    _git(["add", ".planctl/"], tmp_path)
    subprocess.run(
        ["git", "commit", "-m", "chore: seed planctl tree"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
    )


# ---------------------------------------------------------------------------
# claim — success envelope + runtime read-back
# ---------------------------------------------------------------------------


def test_claim_success_envelope_and_runtime(tmp_path, monkeypatch):
    epic_id, task_ids = seed_state(tmp_path, epic_id="fn-1-claim", n_tasks=1)
    task_id = task_ids[0]
    monkeypatch.chdir(tmp_path)

    result = run_cli(["claim", task_id, "--project", str(tmp_path)], env=_SID)
    assert result.exit_code == 0, result.output

    payload = parse_cli_output(result.output)
    assert payload["success"] is True
    assert payload["task_id"] == task_id
    assert payload["epic_id"] == epic_id
    root = str(tmp_path.resolve())
    assert payload["target_repo"] == root
    assert payload["primary_repo"] == root
    assert payload["tier"] == "medium"
    assert payload["worker_agent"] == "plan:worker-medium"
    assert payload["task_state"]["status"] == "in_progress"
    assert payload["task_state"]["outcome"] == "CLAIMED"
    assert payload["epic_state"]["status"] == "open"
    assert payload["brief_ref"] == str(
        tmp_path.resolve() / ".planctl" / "state" / "briefs" / f"{task_id}.json"
    )

    # Runtime state landed on the gitignored state file.
    rt = _runtime(tmp_path, task_id)
    assert rt is not None
    assert rt["status"] == "in_progress"
    assert rt["assignee"] == "test@example.com"


def test_claim_succeeds_without_session_id(tmp_path, monkeypatch):
    """claim is fail-OPEN on the session id: it never builds a mutating
    invocation (readonly emit, gitignored state only), so a missing session id
    must not stop it."""
    _, task_ids = seed_state(tmp_path, epic_id="fn-2-claim", n_tasks=1)
    task_id = task_ids[0]
    monkeypatch.chdir(tmp_path)

    result = run_cli(
        ["claim", task_id, "--project", str(tmp_path)],
        env={"CLAUDE_CODE_SESSION_ID": ""},
    )
    assert result.exit_code == 0, result.output
    assert _runtime(tmp_path, task_id)["status"] == "in_progress"


# ---------------------------------------------------------------------------
# claim — typed error envelopes + the --force matrix
# ---------------------------------------------------------------------------


def test_claim_bad_task_id(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    result = run_cli(["claim", "not-a-task-id", "--project", str(tmp_path)], env=_SID)
    assert result.exit_code != 0
    assert parse_cli_output(result.output)["error"]["code"] == "BAD_TASK_ID"


def test_claim_task_not_found(tmp_path, monkeypatch):
    seed_state(tmp_path, epic_id="fn-3-claim", n_tasks=1)
    monkeypatch.chdir(tmp_path)
    result = run_cli(["claim", "fn-3-claim.9", "--project", str(tmp_path)], env=_SID)
    assert result.exit_code != 0
    assert parse_cli_output(result.output)["error"]["code"] == "TASK_NOT_FOUND"


def test_claim_task_done_never_bypassed_even_with_force(tmp_path, monkeypatch):
    _, task_ids = seed_state(tmp_path, epic_id="fn-4-claim", n_tasks=1)
    task_id = task_ids[0]
    _write_runtime(tmp_path, task_id, {"status": "done", "assignee": "someone@x"})
    monkeypatch.chdir(tmp_path)

    for extra in ([], ["--force"]):
        result = run_cli(
            ["claim", task_id, "--project", str(tmp_path), *extra], env=_SID
        )
        assert result.exit_code != 0, result.output
        assert parse_cli_output(result.output)["error"]["code"] == "TASK_DONE"
        # State unchanged — still done.
        assert _runtime(tmp_path, task_id)["status"] == "done"


def test_claim_claimed_by_other_then_force_takes_over(tmp_path, monkeypatch):
    _, task_ids = seed_state(tmp_path, epic_id="fn-5-claim", n_tasks=1)
    task_id = task_ids[0]
    _write_runtime(
        tmp_path, task_id, {"status": "in_progress", "assignee": "other@example.com"}
    )
    monkeypatch.chdir(tmp_path)

    # Without --force: CLAIMED_BY_OTHER, nothing mutates.
    blocked = run_cli(["claim", task_id, "--project", str(tmp_path)], env=_SID)
    assert blocked.exit_code != 0
    assert parse_cli_output(blocked.output)["error"]["code"] == "CLAIMED_BY_OTHER"
    assert _runtime(tmp_path, task_id)["assignee"] == "other@example.com"

    # With --force: takeover succeeds.
    forced = run_cli(
        ["claim", task_id, "--project", str(tmp_path), "--force"], env=_SID
    )
    assert forced.exit_code == 0, forced.output
    rt = _runtime(tmp_path, task_id)
    assert rt["status"] == "in_progress"
    assert rt["assignee"] == "test@example.com"


def test_claim_blocked_then_force_bypasses(tmp_path, monkeypatch):
    _, task_ids = seed_state(tmp_path, epic_id="fn-6-claim", n_tasks=1)
    task_id = task_ids[0]
    _write_runtime(tmp_path, task_id, {"status": "blocked", "blocked_reason": "stuck"})
    monkeypatch.chdir(tmp_path)

    blocked = run_cli(["claim", task_id, "--project", str(tmp_path)], env=_SID)
    assert blocked.exit_code != 0
    assert parse_cli_output(blocked.output)["error"]["code"] == "TASK_BLOCKED"

    forced = run_cli(
        ["claim", task_id, "--project", str(tmp_path), "--force"], env=_SID
    )
    assert forced.exit_code == 0, forced.output
    assert _runtime(tmp_path, task_id)["status"] == "in_progress"


def test_claim_deps_unmet_then_force_bypasses(tmp_path, monkeypatch):
    _, task_ids = seed_state(
        tmp_path, epic_id="fn-7-claim", n_tasks=2, task_deps={2: [1]}
    )
    dep_id, task_id = task_ids
    monkeypatch.chdir(tmp_path)

    # Dependency .1 is still todo → .2 has unmet deps.
    blocked = run_cli(["claim", task_id, "--project", str(tmp_path)], env=_SID)
    assert blocked.exit_code != 0
    err = parse_cli_output(blocked.output)["error"]
    assert err["code"] == "DEPS_UNMET"
    assert dep_id in err["details"]["unmet"]

    forced = run_cli(
        ["claim", task_id, "--project", str(tmp_path), "--force"], env=_SID
    )
    assert forced.exit_code == 0, forced.output
    assert _runtime(tmp_path, task_id)["status"] == "in_progress"


# ---------------------------------------------------------------------------
# claim — ZERO commits (gitignored state only)
# ---------------------------------------------------------------------------


@pytest.mark.real_git
def test_claim_produces_no_commit(tmp_path, monkeypatch):
    _, task_ids = seed_state(tmp_path, epic_id="fn-8-claim", n_tasks=1)
    task_id = task_ids[0]
    _git_seed(tmp_path)
    monkeypatch.chdir(tmp_path)

    before = _commit_count(tmp_path)
    result = run_cli(["claim", task_id, "--project", str(tmp_path)], env=_SID)
    assert result.exit_code == 0, result.output

    assert _runtime(tmp_path, task_id)["status"] == "in_progress"
    assert _commit_count(tmp_path) == before, "claim must mutate only gitignored state"


# ---------------------------------------------------------------------------
# block — state transition + clears on disk + ZERO commits
# ---------------------------------------------------------------------------


def test_block_sets_blocked_and_reason(tmp_path, monkeypatch):
    _, task_ids = seed_state(tmp_path, epic_id="fn-1-block", n_tasks=1)
    task_id = task_ids[0]
    _write_runtime(
        tmp_path, task_id, {"status": "in_progress", "assignee": "test@example.com"}
    )
    monkeypatch.chdir(tmp_path)

    result = run_cli(["block", task_id, "--reason", "waiting on api"], env=_SID)
    assert result.exit_code == 0, result.output

    rt = _runtime(tmp_path, task_id)
    assert rt["status"] == "blocked"
    assert rt["blocked_reason"] == "waiting on api"


def test_block_done_task_errors(tmp_path, monkeypatch):
    _, task_ids = seed_state(tmp_path, epic_id="fn-2-block", n_tasks=1)
    task_id = task_ids[0]
    _write_runtime(
        tmp_path, task_id, {"status": "done", "assignee": "test@example.com"}
    )
    monkeypatch.chdir(tmp_path)

    result = run_cli(["block", task_id, "--reason", "nope"], env=_SID)
    assert result.exit_code != 0
    # State unchanged — still done.
    assert _runtime(tmp_path, task_id)["status"] == "done"


@pytest.mark.real_git
def test_block_produces_no_commit(tmp_path, monkeypatch):
    _, task_ids = seed_state(tmp_path, epic_id="fn-3-block", n_tasks=1)
    task_id = task_ids[0]
    _write_runtime(
        tmp_path, task_id, {"status": "in_progress", "assignee": "test@example.com"}
    )
    _git_seed(tmp_path)
    monkeypatch.chdir(tmp_path)

    before = _commit_count(tmp_path)
    result = run_cli(["block", task_id, "--reason", "stuck"], env=_SID)
    assert result.exit_code == 0, result.output

    assert _runtime(tmp_path, task_id)["status"] == "blocked"
    assert _commit_count(tmp_path) == before, "block must mutate only gitignored state"


# ---------------------------------------------------------------------------
# done — spec patch + worker_done_at stamp + exactly one commit
# ---------------------------------------------------------------------------


@pytest.mark.real_git
def test_done_stamps_patches_and_commits_once(tmp_path, monkeypatch, fixed_clock):
    _, task_ids = seed_state(tmp_path, epic_id="fn-1-done", n_tasks=1)
    task_id = task_ids[0]
    _write_runtime(
        tmp_path, task_id, {"status": "in_progress", "assignee": "test@example.com"}
    )
    _git_seed(tmp_path)
    monkeypatch.chdir(tmp_path)

    before = _commit_count(tmp_path)
    result = run_cli(["done", task_id, "--summary", "shipped it"], env=_SID)
    assert result.exit_code == 0, result.output

    # Runtime + tracked-def stamp.
    assert _runtime(tmp_path, task_id)["status"] == "done"
    assert _task_def(tmp_path, task_id)["worker_done_at"] == fixed_clock

    # Spec sections patched on disk.
    spec = (tmp_path / ".planctl" / "specs" / f"{task_id}.md").read_text(
        encoding="utf-8"
    )
    assert "shipped it" in spec

    # Exactly one commit, with the done subject and the trailer block.
    assert _commit_count(tmp_path) == before + 1
    msg = _head_message(tmp_path)
    assert msg.splitlines()[0] == f"chore(planctl): done {task_id}"
    assert "Planctl-Op: done" in msg
    assert f"Planctl-Target: {task_id}" in msg
    assert "Planctl-Prev-Op:" in msg
    assert f"Session-Id: {_SID['CLAUDE_CODE_SESSION_ID']}" in msg


def test_done_without_session_id_fails_closed(tmp_path, monkeypatch):
    """done builds a mutating invocation (it rewrites tracked files), so it is
    fail-CLOSED on the session id: a missing one hard-errors before any commit.

    The RuntimeError fires inside emit()'s invocation build, upstream of the
    auto-commit, so this holds on the default (mocked-commit) engine too — no
    real_git needed."""
    _, task_ids = seed_state(tmp_path, epic_id="fn-2-done", n_tasks=1)
    task_id = task_ids[0]
    _write_runtime(
        tmp_path, task_id, {"status": "in_progress", "assignee": "test@example.com"}
    )
    monkeypatch.chdir(tmp_path)

    result = run_cli(
        ["done", task_id, "--summary", "x"], env={"CLAUDE_CODE_SESSION_ID": ""}
    )
    assert result.exit_code != 0, result.output
