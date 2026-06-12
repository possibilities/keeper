"""Tests for planctl reconcile — read-only post-worker verdict.

Coverage:
- One case per verdict (seed the matching state + git history):
  not_started, blocked, in_progress_uncommitted, in_progress_committed,
  state_uncommitted, done, tooling_error.
- Bad/missing/ambiguous id → typed error envelope (exit 1).
- Read-only contract: HEAD unchanged across a call; no `reconcile` commit.
- Readonly-footer assertion: op=reconcile, NULL files/subject.
- Trailer authenticity: a prose body `Task: <id>` line does NOT count; a
  `fn-N.1` does NOT match a `fn-N.10` commit (substring collision).
- Unborn-branch guard: an empty state_repo HEAD is a distinct signal, not
  a tooling error.
- Exhaustiveness: every Verdict member maps to an orchestrator handler.
- `planctl reconcile --help` exits 0.
"""

from __future__ import annotations

import contextlib
import json
import subprocess
from pathlib import Path

import pytest
from .conftest import run_cli, set_roots

# reconcile's verdict is computed from real ``Task:``-trailer commits (parsed
# via ``git log``), HEAD-visibility (``git cat-file``), and an epic-progress
# tally over the ``planctl_git_repo`` fixture's real history — the real git IS
# the subject, so this whole file is ``real_git`` (slow bucket: no
# autocommit/dirty-probe stubs, real ``git init`` + commits). It also drives
# roots discovery against the ``_roots_at_tmp_project`` ``set_roots`` root
# below, which must win over the autouse empty-discovery isolation — ``real_roots`` opts onto
# that controlled tmp root.
pytestmark = [pytest.mark.real_git, pytest.mark.real_roots]


@pytest.fixture(autouse=True)
def _roots_at_tmp_project(request, tmp_path, monkeypatch):
    """Point planctl roots discovery at an isolated root holding only ``tmp_path``.

    Same shape as ``tests/test_resolve_task.py::_roots_at_tmp_project`` — without
    this autouse fixture, discovery scans the real ``~/code`` default and can't
    find the seeded ``fn-N`` task. Ambiguity tests call ``set_roots`` again
    themselves; the later call wins.
    """
    root = tmp_path / "_reconcile_root"
    root.mkdir()
    (root / tmp_path.name).symlink_to(tmp_path, target_is_directory=True)
    set_roots(request, monkeypatch, [root])


def _invoke(args: list[str]) -> tuple[int, dict | None, str]:
    result = run_cli(args)
    obj = _first_envelope(result.output)
    return result.exit_code, obj, result.output


def _first_envelope(output: str) -> dict | None:
    """Return the first JSON object in *output* that is NOT a planctl_invocation
    envelope. Tolerates compact one-line and pretty-printed multi-line JSON."""
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


def _invocation_footer(output: str) -> dict | None:
    """Return the planctl_invocation footer object from *output*, if any."""
    decoder = json.JSONDecoder()
    text = output
    i = 0
    while i < len(text):
        if text[i] == "{":
            with contextlib.suppress(json.JSONDecodeError):
                obj, end = decoder.raw_decode(text[i:])
                if isinstance(obj, dict) and "planctl_invocation" in obj:
                    return obj["planctl_invocation"]
                i += end
                continue
        i += 1
    return None


def _make_epic_with_task(title: str = "Reconcile epic"):
    from .conftest import seed_epic

    epic_id, task_ids = seed_epic(Path.cwd(), title=title, n_tasks=1)
    return epic_id, task_ids[0]


def _set_runtime(project: Path, task_id: str, state: dict) -> None:
    """Write the runtime sidecar directly — bypasses claim/done."""
    state_path = project / ".planctl" / "state" / "tasks" / f"{task_id}.state.json"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(state) + "\n", encoding="utf-8")


def _git(args: list[str], cwd: Path) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


def _commit_with_trailer(project: Path, body: str) -> str:
    """Create an empty commit carrying *body* (incl. any trailers), return sha."""
    _git(["commit", "--allow-empty", "-m", body], project)
    return _git(["rev-parse", "HEAD"], project)


# ---------------------------------------------------------------------------
# Verdict: not_started (status todo)
# ---------------------------------------------------------------------------


def test_reconcile_not_started(planctl_git_repo):
    """A freshly-seeded todo task → not_started."""
    epic_id, task_id = _make_epic_with_task()
    code, obj, output = _invoke(["reconcile", task_id])
    assert code == 0, output
    assert obj is not None
    assert obj.get("success") is True
    assert obj.get("verdict") == "not_started"
    assert obj.get("task_id") == task_id
    assert obj.get("epic_id") == epic_id
    assert obj.get("status") == "todo"
    assert obj.get("source_commits") == []
    assert obj.get("blocked_reason") is None
    assert "assessed_at" in obj


# ---------------------------------------------------------------------------
# Verdict: blocked (carries blocked_reason)
# ---------------------------------------------------------------------------


def test_reconcile_blocked_carries_reason(planctl_git_repo):
    """A blocked task → blocked, with blocked_reason surfaced."""
    _, task_id = _make_epic_with_task()
    _set_runtime(
        planctl_git_repo,
        task_id,
        {"status": "blocked", "blocked_reason": "waiting on upstream"},
    )
    code, obj, output = _invoke(["reconcile", task_id])
    assert code == 0, output
    assert obj is not None
    assert obj.get("verdict") == "blocked"
    assert obj.get("status") == "blocked"
    assert obj.get("blocked_reason") == "waiting on upstream"


# ---------------------------------------------------------------------------
# Verdict: in_progress_uncommitted (in_progress, no source commit)
# ---------------------------------------------------------------------------


def test_reconcile_in_progress_uncommitted(planctl_git_repo):
    """in_progress with no trailer commit → in_progress_uncommitted."""
    _, task_id = _make_epic_with_task()
    _set_runtime(planctl_git_repo, task_id, {"status": "in_progress"})
    code, obj, output = _invoke(["reconcile", task_id])
    assert code == 0, output
    assert obj is not None
    assert obj.get("verdict") == "in_progress_uncommitted"
    assert obj.get("source_commits") == []


# ---------------------------------------------------------------------------
# Verdict: in_progress_committed (in_progress + trailer-authentic commit)
# ---------------------------------------------------------------------------


def test_reconcile_in_progress_committed(planctl_git_repo):
    """in_progress + a real `Task: <id>` trailer commit → in_progress_committed."""
    _, task_id = _make_epic_with_task()
    _set_runtime(planctl_git_repo, task_id, {"status": "in_progress"})
    sha = _commit_with_trailer(
        planctl_git_repo,
        f"feat(x): do the thing\n\nbody line.\n\nTask: {task_id}",
    )
    code, obj, output = _invoke(["reconcile", task_id])
    assert code == 0, output
    assert obj is not None
    assert obj.get("verdict") == "in_progress_committed"
    commits = obj.get("source_commits")
    assert commits and any(c["sha"] == sha for c in commits)
    assert all("repo" in c for c in commits)


# ---------------------------------------------------------------------------
# Verdict: state_uncommitted (status done, worker_done_at NOT in HEAD)
# ---------------------------------------------------------------------------


def test_reconcile_state_uncommitted_stamp_not_in_head(planctl_git_repo):
    """status done on disk but committed HEAD task JSON lacks worker_done_at.

    The realistic auto-commit-failed window: the task JSON IS in HEAD (scaffold
    committed it) carrying worker_done_at=null, the runtime sidecar flipped to
    done, but the `done` stamp+commit never landed → state_uncommitted.
    """
    _, task_id = _make_epic_with_task()
    # Under real_git, scaffold's auto-commit already landed the task JSON in HEAD
    # carrying worker_done_at=null (the pre-`done` shape this verdict models).
    # Stage+commit defensively so the precondition holds even if nothing new is
    # pending (``--allow-empty`` makes the redundant commit a no-op, never an
    # error).
    rel = f".planctl/tasks/{task_id}.json"
    _git(["add", rel], planctl_git_repo)
    _git(
        ["commit", "--allow-empty", "-m", "chore(planctl): seed task json"],
        planctl_git_repo,
    )
    _set_runtime(planctl_git_repo, task_id, {"status": "done"})

    code, obj, output = _invoke(["reconcile", task_id])
    assert code == 0, output
    assert obj is not None
    assert obj.get("verdict") == "state_uncommitted"
    assert obj.get("status") == "done"
    assert obj.get("state_head_visible") is False


def test_reconcile_state_uncommitted_path_not_in_head(planctl_git_repo):
    """status done on disk but the task JSON path isn't in HEAD at all.

    The other auto-commit-failed shape (the whole task JSON commit never landed):
    cat-file misses the path → state_head_visible False → state_uncommitted.
    """
    _, task_id = _make_epic_with_task()
    _set_runtime(planctl_git_repo, task_id, {"status": "done"})
    code, obj, output = _invoke(["reconcile", task_id])
    assert code == 0, output
    assert obj is not None
    assert obj.get("verdict") == "state_uncommitted"
    assert obj.get("state_head_visible") is False


# ---------------------------------------------------------------------------
# Verdict: done (status done AND worker_done_at visible in HEAD)
# ---------------------------------------------------------------------------


def _commit_task_json_with_done_stamp(project: Path, task_id: str) -> None:
    """Stamp worker_done_at on the tracked task JSON and git-commit it.

    Reproduces the on-HEAD state the real ``planctl done`` auto-commit lands:
    the committed task JSON carries a truthy ``worker_done_at``. (The in-process
    invoker path doesn't populate the session touched-paths log, so the verb's
    own auto-commit no-ops here — we land the equivalent commit by hand.)
    """
    from planctl.store import now_iso

    rel = f".planctl/tasks/{task_id}.json"
    task_path = project / rel
    data = json.loads(task_path.read_text(encoding="utf-8"))
    data["worker_done_at"] = now_iso()
    task_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    _git(["add", rel], project)
    _git(
        ["commit", "-m", f"chore(planctl): done {task_id}\n\nTask: {task_id}"], project
    )


def test_reconcile_done(planctl_git_repo):
    """status done AND the committed HEAD task JSON carries worker_done_at → done."""
    _, task_id = _make_epic_with_task()
    # Runtime sidecar flips status to done; HEAD task JSON carries the stamp.
    _set_runtime(planctl_git_repo, task_id, {"status": "done"})
    _commit_task_json_with_done_stamp(planctl_git_repo, task_id)

    code, obj, output = _invoke(["reconcile", task_id])
    assert code == 0, output
    assert obj is not None
    assert obj.get("verdict") == "done"
    assert obj.get("status") == "done"
    assert obj.get("state_head_visible") is True


# ---------------------------------------------------------------------------
# Verdict: tooling_error (fail-closed on a git failure)
# ---------------------------------------------------------------------------


def test_reconcile_tooling_error_fail_closed(planctl_git_repo, monkeypatch):
    """A git subprocess failure during state cat-file → tooling_error, never clean."""
    import planctl.run_reconcile as m

    _, task_id = _make_epic_with_task()
    _set_runtime(planctl_git_repo, task_id, {"status": "done"})

    from planctl.run_reconcile import _GitError

    def _boom(*_a, **_k):
        raise _GitError("simulated git failure")

    monkeypatch.setattr(m, "_state_head_visible", _boom)

    code, obj, output = _invoke(["reconcile", task_id])
    assert code == 0, output
    assert obj is not None
    assert obj.get("verdict") == "tooling_error", (
        "a git failure must fail closed, never a clean done/not_started verdict"
    )
    assert obj.get("state_head_visible") is False


# ---------------------------------------------------------------------------
# Trailer authenticity: prose body line does NOT count
# ---------------------------------------------------------------------------


def test_reconcile_prose_body_does_not_match(planctl_git_repo):
    """A `Task: <id>` line in the BODY (not the trailer block) is not a source commit."""
    _, task_id = _make_epic_with_task()
    _set_runtime(planctl_git_repo, task_id, {"status": "in_progress"})
    # `Task: <id>` is mid-body, followed by more prose → not a trailer block.
    _commit_with_trailer(
        planctl_git_repo,
        f"feat(x): mention things\n\nTask: {task_id}\n\nmore prose after, so this "
        "is not the trailer block.",
    )
    code, obj, output = _invoke(["reconcile", task_id])
    assert code == 0, output
    assert obj is not None
    assert obj.get("verdict") == "in_progress_uncommitted", (
        "a prose body Task: line must not register as a source commit"
    )
    assert obj.get("source_commits") == []


# ---------------------------------------------------------------------------
# Trailer authenticity: fn-N.1 must NOT match an fn-N.10 commit (substring)
# ---------------------------------------------------------------------------


def test_reconcile_no_substring_collision(planctl_git_repo):
    """`<epic>.1` does not match a real `Task: <epic>.10` trailer (no substring)."""
    _, task_id = _make_epic_with_task()  # this is <epic>.1
    epic_id = task_id.rsplit(".", 1)[0]
    sibling = f"{epic_id}.10"
    _set_runtime(planctl_git_repo, task_id, {"status": "in_progress"})
    # A genuine trailer for the .10 sibling — must NOT be picked up for .1.
    _commit_with_trailer(
        planctl_git_repo,
        f"feat(x): sibling work\n\nTask: {sibling}",
    )
    code, obj, output = _invoke(["reconcile", task_id])
    assert code == 0, output
    assert obj is not None
    assert obj.get("verdict") == "in_progress_uncommitted", (
        f"{task_id} must not match the {sibling} trailer by substring"
    )
    assert obj.get("source_commits") == []


# ---------------------------------------------------------------------------
# Trailer parsing: single-line comma-split `Task: a, b` matches BOTH ids
# ---------------------------------------------------------------------------


def test_reconcile_comma_split_trailer_matches_both(planctl_git_repo):
    """`Task: <id1>, <id2>` on ONE trailer line is matched for each id.

    `_find_source_commits` normalizes commas → newlines before the exact-equality
    check, so a single comma-separated `Task:` trailer line covers every id it
    names. Without that branch a comma-joined trailer would match neither id and
    reconcile would emit `not_started`/`in_progress_uncommitted` for a finished
    worker. We seed a two-task epic, drive BOTH tasks to `done` with the stamp in
    HEAD, land ONE commit whose trailer names both, and assert the `done` verdict
    for each — plus a direct `_find_source_commits` assertion that the one sha is
    returned for each id.
    """
    from planctl.run_reconcile import _find_source_commits

    from .conftest import seed_epic

    epic_id, task_ids = seed_epic(Path.cwd(), title="Comma split", n_tasks=2)
    t1, t2 = task_ids
    # Both tasks done on disk; HEAD task JSONs carry the worker_done_at stamp.
    _set_runtime(planctl_git_repo, t1, {"status": "done"})
    _set_runtime(planctl_git_repo, t2, {"status": "done"})
    _commit_task_json_with_done_stamp(planctl_git_repo, t1)
    _commit_task_json_with_done_stamp(planctl_git_repo, t2)

    # ONE source commit whose single trailer line names both ids, comma-joined.
    sha = _commit_with_trailer(
        planctl_git_repo,
        f"feat(x): do both things\n\nbody line.\n\nTask: {t1}, {t2}",
    )

    # Direct parsing-branch assertion: the comma-trailer sha is returned for
    # each id. (The per-task `chore(planctl): done` stamp commits ALSO carry a
    # single-id `Task:` trailer, so the scan legitimately returns more than one
    # sha — what the comma-split branch must guarantee is that THIS sha is among
    # them for both ids.)
    assert sha in _find_source_commits(t1, str(planctl_git_repo))
    assert sha in _find_source_commits(t2, str(planctl_git_repo))

    # And the end-to-end verdict is `done` for each (comma trailer doesn't break).
    for tid in (t1, t2):
        code, obj, output = _invoke(["reconcile", tid])
        assert code == 0, output
        assert obj is not None
        assert obj.get("verdict") == "done", (
            f"{tid} must reach done — comma-split trailer parsing regressed"
        )
        assert obj.get("status") == "done"
        assert obj.get("state_head_visible") is True


# ---------------------------------------------------------------------------
# Cross-repo source scan: target_repo != state_repo, commit lands in target_repo
# ---------------------------------------------------------------------------


def _init_git_repo(repo: Path) -> None:
    """git init *repo* with one commit so HEAD is born (born-branch fixture)."""
    repo.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
    (repo / "README.md").write_text("# target repo\n", encoding="utf-8")
    _git(["add", "README.md"], repo)
    _git(["commit", "-m", "chore: initial commit"], repo)


def _set_task_target_repo(project: Path, task_id: str, target_repo: Path) -> None:
    """Repoint the on-disk task JSON's ``target_repo`` at *target_repo*.

    Scaffold collapses ``target_repo`` to the project root and its mint-time
    integrity check rejects a non-``.git`` path — so we rewrite the field AFTER
    the seed (reconcile re-reads the JSON and does not re-run that check).
    """
    rel = f".planctl/tasks/{task_id}.json"
    task_path = project / rel
    data = json.loads(task_path.read_text(encoding="utf-8"))
    data["target_repo"] = str(target_repo)
    task_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _set_epic_touched_repos(project: Path, epic_id: str, repos: list[str]) -> None:
    """Write ``touched_repos`` onto the on-disk epic JSON."""
    rel = f".planctl/epics/{epic_id}.json"
    epic_path = project / rel
    data = json.loads(epic_path.read_text(encoding="utf-8"))
    data["touched_repos"] = list(repos)
    epic_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def test_reconcile_cross_repo_source_scan_done(planctl_git_repo, tmp_path):
    """target_repo != state_repo: a `Task:` commit in target_repo → `done`.

    The cross-project shape the single-repo verdict tests never exercise. The
    source scan must walk ``target_repo`` (distinct from ``state_repo``) and
    pick up the trailer-authentic commit there, while ``state_head_visible``
    cat-files against ``state_repo``. We seed the epic in ``planctl_git_repo``
    (the state_repo), repoint the task's ``target_repo`` at a SEPARATE git repo,
    land the source commit THERE, stamp+commit worker_done_at in the state_repo,
    and assert the `done` verdict carries a source commit attributed to the
    target_repo.
    """
    epic_id, task_id = _make_epic_with_task(title="Cross repo")
    target_repo = tmp_path / "target_repo"
    _init_git_repo(target_repo)
    _set_task_target_repo(planctl_git_repo, task_id, target_repo)

    # Source commit with the trailer lands in the SEPARATE target_repo, never
    # in the state_repo (planctl_git_repo).
    sha = _commit_with_trailer(
        target_repo,
        f"feat(x): cross-repo work\n\nbody line.\n\nTask: {task_id}",
    )

    # Drive the task done in the state_repo: sidecar flip + the on-HEAD stamp.
    _set_runtime(planctl_git_repo, task_id, {"status": "done"})
    _commit_task_json_with_done_stamp(planctl_git_repo, task_id)

    code, obj, output = _invoke(["reconcile", task_id])
    assert code == 0, output
    assert obj is not None
    assert obj.get("verdict") == "done", (
        "cross-repo target_repo source scan regressed — wrong verdict for a "
        "finished cross-project task"
    )
    assert obj.get("status") == "done"
    assert obj.get("state_head_visible") is True
    commits = obj.get("source_commits")
    assert commits, "the target_repo Task: commit must be surfaced"
    match = next((c for c in commits if c["sha"] == sha), None)
    assert match is not None, f"target_repo commit {sha} not in {commits}"
    assert match["repo"] == str(target_repo), (
        "the source commit must be attributed to target_repo, not state_repo"
    )


def test_reconcile_cross_repo_dedup_no_duplicate_scan(planctl_git_repo, tmp_path):
    """A repo reachable via both target_repo AND touched_repos is scanned once.

    ``ordered_scan_repos`` dedups (realpath-normalized, order-preserving), so a
    target_repo that ALSO appears in ``epic.touched_repos`` must not yield two
    copies of the same source commit. Without the dedup the orchestrator would
    see a doubled ``source_commits`` list for the same sha.
    """
    epic_id, task_id = _make_epic_with_task(title="Cross repo dedup")
    target_repo = tmp_path / "dedup_repo"
    _init_git_repo(target_repo)
    _set_task_target_repo(planctl_git_repo, task_id, target_repo)
    # Same repo reachable a second time via touched_repos → must be deduped.
    _set_epic_touched_repos(planctl_git_repo, epic_id, [str(target_repo)])

    sha = _commit_with_trailer(
        target_repo,
        f"feat(x): dedup work\n\nTask: {task_id}",
    )
    _set_runtime(planctl_git_repo, task_id, {"status": "in_progress"})

    code, obj, output = _invoke(["reconcile", task_id])
    assert code == 0, output
    assert obj is not None
    assert obj.get("verdict") == "in_progress_committed"
    matching = [c for c in obj.get("source_commits", []) if c["sha"] == sha]
    assert len(matching) == 1, (
        f"target_repo also in touched_repos must scan once, got {matching}"
    )


# ---------------------------------------------------------------------------
# Unborn-branch guard: empty HEAD is a distinct signal, not tooling_error
# ---------------------------------------------------------------------------


def test_reconcile_unborn_branch_guard(tmp_path, monkeypatch):
    """state_repo with no born HEAD → state_head_visible False, not tooling_error.

    Build a state_repo with NO commits (unborn branch). The done-status task's
    cat-file must read False (distinct unborn signal), landing state_uncommitted
    rather than tooling_error.
    """
    from planctl.run_reconcile import _state_head_visible

    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-session-fixture")
    repo = tmp_path / "unborn"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
    # No commit → unborn branch. `_state_head_visible` must return False, not raise.
    assert _state_head_visible(str(repo), "fn-1-x.1") is False


# ---------------------------------------------------------------------------
# Bad / missing / ambiguous id → typed error envelope (exit 1)
# ---------------------------------------------------------------------------


def test_reconcile_bad_id(planctl_git_repo):
    code, obj, output = _invoke(["reconcile", "not-a-task-id"])
    assert code != 0, output
    assert obj is not None
    assert obj.get("success") is False
    assert obj.get("error", {}).get("code") == "BAD_TASK_ID"


def test_reconcile_not_found(planctl_git_repo):
    code, obj, output = _invoke(["reconcile", "fn-9999-no-task.1"])
    assert code != 0, output
    assert obj is not None
    assert obj.get("success") is False
    assert obj.get("error", {}).get("code") == "TASK_NOT_FOUND"


def test_reconcile_project_not_a_project(planctl_git_repo, tmp_path):
    not_a_proj = tmp_path / "not-a-planctl-proj"
    not_a_proj.mkdir()
    code, obj, output = _invoke(
        ["reconcile", "fn-1-foo.1", "--project", str(not_a_proj)]
    )
    assert code != 0, output
    assert obj is not None
    assert obj.get("error", {}).get("code") == "NOT_A_PROJECT"


# ---------------------------------------------------------------------------
# Read-only contract: no commit lands; readonly footer carried.
# ---------------------------------------------------------------------------


def test_reconcile_lands_no_commit(planctl_git_repo):
    """reconcile is read-only — HEAD unchanged, no `reconcile` commit subject."""
    _, task_id = _make_epic_with_task()
    head_before = _git(["rev-parse", "HEAD"], planctl_git_repo)

    code, obj, output = _invoke(["reconcile", task_id])
    assert code == 0, output
    assert obj is not None

    head_after = _git(["rev-parse", "HEAD"], planctl_git_repo)
    assert head_before == head_after, "reconcile must not land a commit"

    # No `chore(planctl): reconcile ...` verb-commit subject in recent history.
    # Match the verb-commit prefix, not the bare word — the seeded epic's own
    # slug (``fn-1-reconcile-epic``) legitimately contains "reconcile".
    log = _git(["log", "-5", "--pretty=%s"], planctl_git_repo)
    assert "chore(planctl): reconcile" not in log


def test_reconcile_envelope_carries_readonly_invocation(planctl_git_repo):
    """The planctl_invocation footer has op=reconcile and NULL files/subject."""
    _, task_id = _make_epic_with_task()
    result = run_cli(["reconcile", task_id])
    assert result.exit_code == 0, result.output
    footer = _invocation_footer(result.output)
    assert footer is not None, f"no planctl_invocation footer:\n{result.output}"
    assert footer.get("op") == "reconcile"
    assert footer.get("subject") is None
    assert footer.get("files") is None


# ---------------------------------------------------------------------------
# epic_progress is reporting-only: present, shaped {done, total}.
# ---------------------------------------------------------------------------


def test_reconcile_epic_progress_reporting(planctl_git_repo):
    """epic_progress carries {done, total} and reflects the tally, not the verdict."""
    from .conftest import seed_epic

    epic_id, task_ids = seed_epic(Path.cwd(), title="Multi", n_tasks=2)
    # Mark the first done (sidecar only — does not affect THIS task's verdict).
    _set_runtime(planctl_git_repo, task_ids[0], {"status": "done"})

    code, obj, output = _invoke(["reconcile", task_ids[1]])
    assert code == 0, output
    assert obj is not None
    prog = obj.get("epic_progress")
    assert prog == {"done": 1, "total": 2}


# ---------------------------------------------------------------------------
# Exhaustiveness: every Verdict member maps to an orchestrator handler.
# ---------------------------------------------------------------------------


# The set of verdicts the /plan:work orchestrator switches on. Mirrors the
# truth table in run_reconcile + the work skill's post-worker switch (task .3).
# This test is the standing guard that no verdict ships without a handler.
_ORCHESTRATOR_HANDLERS = {
    "done",
    "in_progress_committed",
    "in_progress_uncommitted",
    "blocked",
    "state_uncommitted",
    "not_started",
    "tooling_error",
}


def test_reconcile_verdict_exhaustiveness():
    """Every Verdict member has an orchestrator handler and vice versa."""
    from planctl.run_reconcile import Verdict

    members = {v.value for v in Verdict}
    assert members == _ORCHESTRATOR_HANDLERS, (
        "Verdict members and orchestrator handlers diverged: "
        f"verdicts only={members - _ORCHESTRATOR_HANDLERS}, "
        f"handlers only={_ORCHESTRATOR_HANDLERS - members}"
    )


def test_reconcile_compute_verdict_truth_table():
    """Direct truth-table coverage of `_compute_verdict` over (status, signals)."""
    from planctl.run_reconcile import Verdict, _compute_verdict

    assert (
        _compute_verdict("done", has_source_commit=False, state_head_visible=True)
        == Verdict.DONE
    )
    assert (
        _compute_verdict("done", has_source_commit=False, state_head_visible=False)
        == Verdict.STATE_UNCOMMITTED
    )
    assert (
        _compute_verdict(
            "in_progress", has_source_commit=True, state_head_visible=False
        )
        == Verdict.IN_PROGRESS_COMMITTED
    )
    assert (
        _compute_verdict(
            "in_progress", has_source_commit=False, state_head_visible=False
        )
        == Verdict.IN_PROGRESS_UNCOMMITTED
    )
    assert (
        _compute_verdict("blocked", has_source_commit=False, state_head_visible=False)
        == Verdict.BLOCKED
    )
    assert (
        _compute_verdict("todo", has_source_commit=False, state_head_visible=False)
        == Verdict.NOT_STARTED
    )


# ---------------------------------------------------------------------------
# --help exits 0 (work-skill consistency test consumes this).
# ---------------------------------------------------------------------------


def test_reconcile_help_exits_zero():
    result = run_cli(["reconcile", "--help"])
    assert result.exit_code == 0, result.output
    assert "reconcile" in result.output.lower()
