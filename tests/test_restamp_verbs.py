"""Engine-agnostic conformance spec for the in-wave mutating verbs.

The mutating-side companion to ``tests/test_query_verbs.py`` — the executable
spec the ``planctl-bun`` port targets for its setter family, dep editors, and
the short-circuiting/conditionally-mutating verbs. Every fixture is seeded with
the CLI-free ``seed_state`` disk builder + ``monkeypatch.chdir`` (the
``tests/test_worker_verbs.py`` seeding shape), never ``seed_epic`` / ``scaffold``
(the bun binary implements no scaffold). Under conformance only the
verb-under-test crosses the ``PLANCTL_BIN`` subprocess boundary. The existing
scaffold-poisoned setter/validate test files are left untouched — this module
re-expresses the mutating surface from a clean ``seed_state`` baseline.

What is pinned:

* Setters that re-stamp ``last_validated_at`` (``set-description`` /
  ``set-acceptance`` from file AND stdin, ``reset`` incl. ``--cascade``,
  ``set-target-repo`` with the touched_repos recompute, the warn-and-write
  ``set-primary-repo`` / ``set-touched-repos``) bump the marker to the frozen
  ``PLANCTL_NOW`` after the post-write integrity check passes.
* The non-restamp setters: ``task set-tier`` (gate on the tier choice, marker
  untouched) and the plain ``epic set-branch`` / ``set-title`` (no marker move).
* The short-circuiting verbs ``epic invalidate`` / ``epic queue-jump`` and
  ``refine-context --invalidate``: already-in-target-state → readonly envelope,
  ZERO commit; else write + a mutating commit.
* The dep editors: ``add-dep`` (fn-N normalization, cross-project resolution via
  multi-root ``seed_state`` + ``set_roots``, cycle → rollback with prior state
  restored), ``add-deps`` (``--skip-invalid`` result statuses, error priority,
  no-write when zero new edges), ``rm-dep`` (idempotent).
* The cross-cutting restamp-failure fail-forward: a missing sibling-task spec
  fails the post-write integrity check → ``integrity_failed`` compact envelope,
  exit 1, the structural write STILL on disk, the marker left stale.
* Commit subjects per mutating verb + the two-file auto-commit scope for
  ``set-target-repo``.

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

from .conftest import parse_cli_output, run_cli, seed_state, set_roots

_SID = {"CLAUDE_CODE_SESSION_ID": "test-restamp-verbs"}


# ---------------------------------------------------------------------------
# Helpers — disk + git, no Python internals.
# ---------------------------------------------------------------------------


def _epic_def(tmp_path: Path, epic_id: str) -> dict:
    p = tmp_path / ".planctl" / "epics" / f"{epic_id}.json"
    return json.loads(p.read_text(encoding="utf-8"))


def _task_def(tmp_path: Path, task_id: str) -> dict:
    p = tmp_path / ".planctl" / "tasks" / f"{task_id}.json"
    return json.loads(p.read_text(encoding="utf-8"))


def _spec(tmp_path: Path, spec_id: str) -> str:
    p = tmp_path / ".planctl" / "specs" / f"{spec_id}.md"
    return p.read_text(encoding="utf-8")


def _runtime(tmp_path: Path, task_id: str) -> dict | None:
    p = tmp_path / ".planctl" / "state" / "tasks" / f"{task_id}.state.json"
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def _write_runtime(tmp_path: Path, task_id: str, state: dict) -> None:
    d = tmp_path / ".planctl" / "state" / "tasks"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{task_id}.state.json").write_text(
        json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def _git(args: list[str], cwd: Path) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=True
    ).stdout


def _commit_count(repo: Path) -> int:
    return int(_git(["rev-list", "--count", "HEAD"], repo).strip())


def _head_subject(repo: Path) -> str:
    return _git(["log", "-1", "--format=%s"], repo).strip()


def _head_files(repo: Path) -> list[str]:
    out = _git(["diff-tree", "--no-commit-id", "-r", "--name-only", "HEAD"], repo)
    return [f.strip() for f in out.splitlines() if f.strip()]


def _git_seed(tmp_path: Path) -> None:
    """Turn a ``seed_state`` tree into a clean git baseline so any later dirty
    state is attributable to the verb under test."""
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    _git(["add", ".planctl/"], tmp_path)
    subprocess.run(
        ["git", "commit", "-m", "chore: seed planctl tree"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
    )


def _stamp_marker(tmp_path: Path, epic_id: str, value) -> None:
    """Overwrite ``last_validated_at`` directly on the epic JSON (test seam)."""
    p = tmp_path / ".planctl" / "epics" / f"{epic_id}.json"
    ed = json.loads(p.read_text(encoding="utf-8"))
    ed["last_validated_at"] = value
    p.write_text(json.dumps(ed, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _first_obj(output: str) -> dict:
    """First JSON object in CLI output, tolerant of a trailing stderr WARN line.

    The merged (stdout + stderr) stream can carry a ``WARN:`` line after the
    primary envelope, so a whole-string ``json.loads`` would choke on the extra
    data. A raw-decode scan returns just the first complete object."""
    decoder = json.JSONDecoder()
    i = 0
    while i < len(output):
        if output[i] != "{":
            i += 1
            continue
        try:
            obj, _ = decoder.raw_decode(output, i)
        except json.JSONDecodeError:
            i += 1
            continue
        if isinstance(obj, dict) and set(obj.keys()) != {"planctl_invocation"}:
            return obj
        i += 1
    raise AssertionError(f"no JSON object in output:\n{output}")


# ---------------------------------------------------------------------------
# set-description / set-acceptance — section patch + restamp (file + stdin)
# ---------------------------------------------------------------------------


def test_set_description_from_file_patches_and_restamps(
    tmp_path, monkeypatch, fixed_clock
):
    seed_state(tmp_path, epic_id="fn-1-sd", n_tasks=1)
    assert _epic_def(tmp_path, "fn-1-sd")["last_validated_at"] is None
    desc_file = tmp_path / "desc.md"
    desc_file.write_text("brand new description body\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    result = run_cli(
        ["task", "set-description", "fn-1-sd.1", "--file", str(desc_file)],
        cwd=tmp_path,
        env=_SID,
    )
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["task_id"] == "fn-1-sd.1"
    assert payload["section"] == "Description"

    assert "brand new description body" in _spec(tmp_path, "fn-1-sd.1")
    # Marker re-stamped to the frozen clock.
    assert _epic_def(tmp_path, "fn-1-sd")["last_validated_at"] == fixed_clock


def test_set_acceptance_from_stdin_patches_and_restamps(
    tmp_path, monkeypatch, fixed_clock
):
    seed_state(tmp_path, epic_id="fn-1-sa", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    result = run_cli(
        ["task", "set-acceptance", "fn-1-sa.1"],
        cwd=tmp_path,
        env=_SID,
        input_text="- [ ] new criterion from stdin\n",
    )
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["section"] == "Acceptance"

    assert "new criterion from stdin" in _spec(tmp_path, "fn-1-sa.1")
    assert _epic_def(tmp_path, "fn-1-sa")["last_validated_at"] == fixed_clock


@pytest.mark.real_git
def test_set_description_commit_subject(tmp_path, monkeypatch, fixed_clock):
    seed_state(tmp_path, epic_id="fn-2-sd", n_tasks=1)
    _git_seed(tmp_path)
    monkeypatch.chdir(tmp_path)

    before = _commit_count(tmp_path)
    result = run_cli(
        ["task", "set-description", "fn-2-sd.1"],
        cwd=tmp_path,
        env=_SID,
        input_text="body\n",
    )
    assert result.exit_code == 0, result.output
    assert _commit_count(tmp_path) == before + 1
    assert _head_subject(tmp_path) == "chore(planctl): set-description fn-2-sd.1"


# ---------------------------------------------------------------------------
# reset — runtime cleared, spec sections emptied, worker_done_at nulled, cascade
# ---------------------------------------------------------------------------


def test_reset_clears_runtime_and_spec_and_done_stamp(
    tmp_path, monkeypatch, fixed_clock
):
    seed_state(tmp_path, epic_id="fn-1-rst", n_tasks=1)
    # Make the task look done: runtime done + worker_done_at + a filled spec.
    _write_runtime(
        tmp_path, "fn-1-rst.1", {"status": "done", "assignee": "test@example.com"}
    )
    td = _task_def(tmp_path, "fn-1-rst.1")
    td["worker_done_at"] = "2026-01-01T00:00:00.000000Z"
    (tmp_path / ".planctl" / "tasks" / "fn-1-rst.1.json").write_text(
        json.dumps(td, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    spec_path = tmp_path / ".planctl" / "specs" / "fn-1-rst.1.md"
    spec_path.write_text(
        "## Description\nx\n\n## Acceptance\n- [ ] x\n\n"
        "## Done summary\nall shipped\n\n## Evidence\nlots\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)

    result = run_cli(["task", "reset", "fn-1-rst.1"], cwd=tmp_path, env=_SID)
    assert result.exit_code == 0, result.output

    assert _runtime(tmp_path, "fn-1-rst.1")["status"] == "todo"
    assert _task_def(tmp_path, "fn-1-rst.1")["worker_done_at"] is None
    spec = _spec(tmp_path, "fn-1-rst.1")
    assert "all shipped" not in spec
    assert "lots" not in spec
    # Marker re-stamped on reset (it IS a restamp member).
    assert _epic_def(tmp_path, "fn-1-rst")["last_validated_at"] == fixed_clock


def test_reset_cascade_resets_dependents(tmp_path, monkeypatch):
    # .2 depends on .1 → reset --cascade on .1 also resets .2.
    seed_state(tmp_path, epic_id="fn-2-rst", n_tasks=2, task_deps={2: [1]})
    for tid in ("fn-2-rst.1", "fn-2-rst.2"):
        _write_runtime(
            tmp_path, tid, {"status": "done", "assignee": "test@example.com"}
        )
    monkeypatch.chdir(tmp_path)

    result = run_cli(
        ["task", "reset", "fn-2-rst.1", "--cascade"], cwd=tmp_path, env=_SID
    )
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["cascade_reset"] == ["fn-2-rst.2"]
    assert _runtime(tmp_path, "fn-2-rst.1")["status"] == "todo"
    assert _runtime(tmp_path, "fn-2-rst.2")["status"] == "todo"


# ---------------------------------------------------------------------------
# set-target-repo — touched_repos recompute before restamp + two-file commit
# ---------------------------------------------------------------------------


def test_set_target_repo_recomputes_touched_repos(tmp_path, monkeypatch, fixed_clock):
    repo_a = tmp_path / "repo_a"
    repo_b = tmp_path / "repo_b"
    for r in (repo_a, repo_b):
        r.mkdir()
        (r / ".git").mkdir()
    seed_state(tmp_path, epic_id="fn-1-str", n_tasks=2, primary_repo=str(repo_a))
    monkeypatch.chdir(tmp_path)

    # Point .1 at repo_b; .2 still at repo_a → touched_repos becomes both, sorted.
    result = run_cli(
        ["task", "set-target-repo", "fn-1-str.1", "--path", str(repo_b)],
        cwd=tmp_path,
        env=_SID,
    )
    assert result.exit_code == 0, result.output
    assert _task_def(tmp_path, "fn-1-str.1")["target_repo"] == str(repo_b.resolve())

    epic = _epic_def(tmp_path, "fn-1-str")
    assert epic["touched_repos"] == sorted(
        [str(repo_a.resolve()), str(repo_b.resolve())]
    )
    assert epic["last_validated_at"] == fixed_clock


@pytest.mark.real_git
def test_set_target_repo_commit_scopes_two_files(tmp_path, monkeypatch):
    repo_b = tmp_path / "repo_b"
    repo_b.mkdir()
    (repo_b / ".git").mkdir()
    seed_state(tmp_path, epic_id="fn-2-str", n_tasks=1, primary_repo=str(tmp_path))
    (tmp_path / ".git").mkdir(exist_ok=True)
    _git_seed(tmp_path)
    monkeypatch.chdir(tmp_path)

    before = _commit_count(tmp_path)
    result = run_cli(
        ["task", "set-target-repo", "fn-2-str.1", "--path", str(repo_b)],
        cwd=tmp_path,
        env=_SID,
    )
    assert result.exit_code == 0, result.output
    assert _commit_count(tmp_path) == before + 1
    assert _head_subject(tmp_path) == "chore(planctl): set-target-repo fn-2-str.1"
    # Both the task JSON and the epic JSON ride the one commit.
    files = set(_head_files(tmp_path))
    assert ".planctl/tasks/fn-2-str.1.json" in files
    assert ".planctl/epics/fn-2-str.json" in files


# ---------------------------------------------------------------------------
# set-primary-repo / set-touched-repos — warn-and-write (warnings + WARN: + 0)
# ---------------------------------------------------------------------------


def test_set_primary_repo_valid_restamps(tmp_path, monkeypatch, fixed_clock):
    repo = tmp_path / "real_repo"
    repo.mkdir()
    (repo / ".git").mkdir()
    seed_state(tmp_path, epic_id="fn-1-spr", n_tasks=1, primary_repo=str(tmp_path))
    (tmp_path / ".git").mkdir(exist_ok=True)
    monkeypatch.chdir(tmp_path)

    result = run_cli(
        ["epic", "set-primary-repo", "fn-1-spr", "--path", str(repo)],
        cwd=tmp_path,
        env=_SID,
    )
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["primary_repo"] == str(repo.resolve())
    assert payload["warnings"] == []
    assert _epic_def(tmp_path, "fn-1-spr")["last_validated_at"] == fixed_clock


def test_set_touched_repos_bad_path_warns_and_writes(tmp_path, monkeypatch):
    """A non-repo path: warnings array populated, WARN: on stderr, exit 0, and
    the write still lands. The post-write restamp gate (check_filesystem_repos
    False for set-*-repo) does not reject the missing-.git/ path."""
    missing = tmp_path / "not_a_repo"  # exists but no .git/
    missing.mkdir()
    seed_state(tmp_path, epic_id="fn-1-stp", n_tasks=1, primary_repo=str(tmp_path))
    (tmp_path / ".git").mkdir(exist_ok=True)
    monkeypatch.chdir(tmp_path)

    result = run_cli(
        ["epic", "set-touched-repos", "fn-1-stp", "--paths", str(missing)],
        cwd=tmp_path,
        env=_SID,
    )
    assert result.exit_code == 0, result.output
    assert "WARN:" in result.output
    payload = _first_obj(result.output)
    assert payload["touched_repos"] == [str(missing.resolve())]
    assert len(payload["warnings"]) == 1
    # Write landed despite the warning.
    assert _epic_def(tmp_path, "fn-1-stp")["touched_repos"] == [str(missing.resolve())]


# ---------------------------------------------------------------------------
# task set-tier — gate on the choice, NOT a restamp member (marker untouched)
# ---------------------------------------------------------------------------


def test_set_tier_writes_and_leaves_marker(tmp_path, monkeypatch, fixed_clock):
    seed_state(tmp_path, epic_id="fn-1-tier", n_tasks=1)
    # Pre-stamp the marker so we can prove set-tier does NOT touch it.
    _stamp_marker(tmp_path, "fn-1-tier", "2026-01-01T00:00:00.000000Z")
    monkeypatch.chdir(tmp_path)

    result = run_cli(
        ["task", "set-tier", "fn-1-tier.1", "--tier", "high"], cwd=tmp_path, env=_SID
    )
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["tier"] == "high"
    assert _task_def(tmp_path, "fn-1-tier.1")["tier"] == "high"
    # Marker untouched — set-tier is not a restamp member.
    assert (
        _epic_def(tmp_path, "fn-1-tier")["last_validated_at"]
        == "2026-01-01T00:00:00.000000Z"
    )


# ---------------------------------------------------------------------------
# epic set-branch / set-title — plain writes, no restamp
# ---------------------------------------------------------------------------


def test_set_branch_plain_write_no_restamp(tmp_path, monkeypatch):
    seed_state(tmp_path, epic_id="fn-1-br", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    result = run_cli(
        ["epic", "set-branch", "fn-1-br", "--branch", "feat/x"], cwd=tmp_path, env=_SID
    )
    assert result.exit_code == 0, result.output
    assert _epic_def(tmp_path, "fn-1-br")["branch_name"] == "feat/x"
    # set-branch is not a restamp member — marker stays None.
    assert _epic_def(tmp_path, "fn-1-br")["last_validated_at"] is None


def test_set_title_plain_write(tmp_path, monkeypatch):
    seed_state(tmp_path, epic_id="fn-1-tl", title="Old", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    result = run_cli(
        ["epic", "set-title", "fn-1-tl", "--title", "New Name"], cwd=tmp_path, env=_SID
    )
    assert result.exit_code == 0, result.output
    assert _epic_def(tmp_path, "fn-1-tl")["title"] == "New Name"


# ---------------------------------------------------------------------------
# epic invalidate — short-circuit when already null, write on stamped→None
# ---------------------------------------------------------------------------


@pytest.mark.real_git
def test_invalidate_short_circuit_when_already_null(tmp_path, monkeypatch):
    seed_state(tmp_path, epic_id="fn-1-inv", n_tasks=1)
    assert _epic_def(tmp_path, "fn-1-inv")["last_validated_at"] is None
    _git_seed(tmp_path)
    monkeypatch.chdir(tmp_path)

    before = _commit_count(tmp_path)
    result = run_cli(["epic", "invalidate", "fn-1-inv"], cwd=tmp_path, env=_SID)
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["short_circuited"] is True
    # Readonly short-circuit → ZERO commits.
    assert _commit_count(tmp_path) == before


@pytest.mark.real_git
def test_invalidate_clears_stamped_marker_and_commits(tmp_path, monkeypatch):
    seed_state(tmp_path, epic_id="fn-2-inv", n_tasks=1)
    _stamp_marker(tmp_path, "fn-2-inv", "2026-01-01T00:00:00.000000Z")
    _git_seed(tmp_path)
    monkeypatch.chdir(tmp_path)

    before = _commit_count(tmp_path)
    result = run_cli(["epic", "invalidate", "fn-2-inv"], cwd=tmp_path, env=_SID)
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["short_circuited"] is False
    assert _epic_def(tmp_path, "fn-2-inv")["last_validated_at"] is None
    assert _commit_count(tmp_path) == before + 1
    assert _head_subject(tmp_path) == "chore(planctl): invalidate fn-2-inv"


# ---------------------------------------------------------------------------
# epic queue-jump — short-circuit when already true, write on false→true
# ---------------------------------------------------------------------------


@pytest.mark.real_git
def test_queue_jump_sets_flag_and_commits(tmp_path, monkeypatch):
    seed_state(tmp_path, epic_id="fn-1-qj", n_tasks=1)
    _git_seed(tmp_path)
    monkeypatch.chdir(tmp_path)

    before = _commit_count(tmp_path)
    result = run_cli(["epic", "queue-jump", "fn-1-qj"], cwd=tmp_path, env=_SID)
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["short_circuited"] is False
    assert _epic_def(tmp_path, "fn-1-qj")["queue_jump"] is True
    assert _commit_count(tmp_path) == before + 1
    assert _head_subject(tmp_path) == "chore(planctl): queue-jump fn-1-qj"


@pytest.mark.real_git
def test_queue_jump_short_circuit_when_already_true(tmp_path, monkeypatch):
    seed_state(tmp_path, epic_id="fn-2-qj", n_tasks=1)
    epic_path = tmp_path / ".planctl" / "epics" / "fn-2-qj.json"
    ed = json.loads(epic_path.read_text(encoding="utf-8"))
    ed["queue_jump"] = True
    epic_path.write_text(json.dumps(ed, indent=2, sort_keys=True) + "\n", "utf-8")
    _git_seed(tmp_path)
    monkeypatch.chdir(tmp_path)

    before = _commit_count(tmp_path)
    result = run_cli(["epic", "queue-jump", "fn-2-qj"], cwd=tmp_path, env=_SID)
    assert result.exit_code == 0, result.output
    assert parse_cli_output(result.output)["short_circuited"] is True
    assert _commit_count(tmp_path) == before


# ---------------------------------------------------------------------------
# refine-context --invalidate — both branches
# ---------------------------------------------------------------------------


def test_refine_context_invalidate_clears_stamped(tmp_path, monkeypatch):
    seed_state(tmp_path, epic_id="fn-1-rc", n_tasks=1)
    _stamp_marker(tmp_path, "fn-1-rc", "2026-01-01T00:00:00.000000Z")
    monkeypatch.chdir(tmp_path)

    result = run_cli(
        ["refine-context", "fn-1-rc", "--invalidate"], cwd=tmp_path, env=_SID
    )
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["invalidated"] is True
    assert payload["last_validated_at"] is None
    assert _epic_def(tmp_path, "fn-1-rc")["last_validated_at"] is None


def test_refine_context_invalidate_short_circuit_when_null(tmp_path, monkeypatch):
    seed_state(tmp_path, epic_id="fn-2-rc", n_tasks=1)
    assert _epic_def(tmp_path, "fn-2-rc")["last_validated_at"] is None
    monkeypatch.chdir(tmp_path)

    result = run_cli(
        ["refine-context", "fn-2-rc", "--invalidate"], cwd=tmp_path, env=_SID
    )
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["invalidated"] is False
    assert payload["last_validated_at"] is None


# ---------------------------------------------------------------------------
# epic add-dep — fn-N normalization, cross-project, cycle rollback, idempotent
# ---------------------------------------------------------------------------


def test_add_dep_wires_and_restamps(tmp_path, monkeypatch, fixed_clock):
    seed_state(tmp_path, epic_id="fn-1-dep", n_tasks=1)
    seed_state(tmp_path, epic_id="fn-2-dep", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    result = run_cli(
        ["epic", "add-dep", "fn-1-dep", "fn-2-dep"], cwd=tmp_path, env=_SID
    )
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    assert payload["depends_on_epics"] == ["fn-2-dep"]
    assert _epic_def(tmp_path, "fn-1-dep")["last_validated_at"] == fixed_clock


def test_add_dep_normalizes_number_only_to_full_slug(tmp_path, monkeypatch):
    """A bare ``fn-N`` dep id is persisted as the resolved FULL slug."""
    seed_state(tmp_path, epic_id="fn-1-norm", n_tasks=1)
    seed_state(tmp_path, epic_id="fn-2-norm", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    result = run_cli(["epic", "add-dep", "fn-1-norm", "fn-2"], cwd=tmp_path, env=_SID)
    assert result.exit_code == 0, result.output
    assert _epic_def(tmp_path, "fn-1-norm")["depends_on_epics"] == ["fn-2-norm"]


@pytest.mark.real_roots
def test_add_dep_cross_project_via_roots(tmp_path, monkeypatch, request):
    """The dep epic lives in a sibling project under a shared root; resolution
    is cwd-then-global, so add-dep wires the cross-project edge."""
    proj_a = tmp_path / "a"
    proj_b = tmp_path / "b"
    proj_a.mkdir()
    proj_b.mkdir()
    seed_state(proj_a, epic_id="fn-1-xa", n_tasks=1)
    seed_state(proj_b, epic_id="fn-2-xb", n_tasks=1)
    set_roots(request, monkeypatch, [tmp_path])
    monkeypatch.chdir(proj_a)

    result = run_cli(["epic", "add-dep", "fn-1-xa", "fn-2-xb"], cwd=proj_a, env=_SID)
    assert result.exit_code == 0, result.output
    assert _epic_def(proj_a, "fn-1-xa")["depends_on_epics"] == ["fn-2-xb"]


def test_add_dep_cycle_rolls_back(tmp_path, monkeypatch):
    """Wiring an edge that closes an A→B→A epic-dep cycle is rejected by the
    post-write integrity gate, and the prior (cycle-free) state is restored."""
    seed_state(tmp_path, epic_id="fn-1-cyc", n_tasks=1)
    seed_state(tmp_path, epic_id="fn-2-cyc", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    # fn-2 → fn-1 first (no cycle yet).
    first = run_cli(["epic", "add-dep", "fn-2-cyc", "fn-1-cyc"], cwd=tmp_path, env=_SID)
    assert first.exit_code == 0, first.output
    assert _epic_def(tmp_path, "fn-2-cyc")["depends_on_epics"] == ["fn-1-cyc"]

    # fn-1 → fn-2 would close the cycle → rejected, fn-1 left untouched.
    second = run_cli(
        ["epic", "add-dep", "fn-1-cyc", "fn-2-cyc"], cwd=tmp_path, env=_SID
    )
    assert second.exit_code == 1, second.output
    payload = parse_cli_output(second.output)
    assert payload["error"]["code"] == "integrity_failed"
    # Rollback: fn-1's dep list is restored to empty (the pre-write state).
    assert _epic_def(tmp_path, "fn-1-cyc")["depends_on_epics"] == []


def test_add_dep_already_exists_errors(tmp_path, monkeypatch):
    seed_state(tmp_path, epic_id="fn-1-ae", n_tasks=1)
    seed_state(tmp_path, epic_id="fn-2-ae", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    first = run_cli(["epic", "add-dep", "fn-1-ae", "fn-2-ae"], cwd=tmp_path, env=_SID)
    assert first.exit_code == 0, first.output
    again = run_cli(["epic", "add-dep", "fn-1-ae", "fn-2-ae"], cwd=tmp_path, env=_SID)
    assert again.exit_code != 0
    assert "already exists" in again.output


# ---------------------------------------------------------------------------
# epic add-deps — skip-invalid statuses, error priority, no-write on zero edges
# ---------------------------------------------------------------------------


def test_add_deps_wired_and_already_present(tmp_path, monkeypatch):
    seed_state(tmp_path, epic_id="fn-1-ad", n_tasks=1)
    seed_state(tmp_path, epic_id="fn-2-ad", n_tasks=1)
    seed_state(tmp_path, epic_id="fn-3-ad", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    first = run_cli(["epic", "add-deps", "fn-1-ad", "fn-2-ad"], cwd=tmp_path, env=_SID)
    assert first.exit_code == 0, first.output

    # Re-supply fn-2 (ALREADY_PRESENT) + fn-3 (WIRED) in one call.
    second = run_cli(
        ["epic", "add-deps", "fn-1-ad", "fn-2-ad", "fn-3-ad"], cwd=tmp_path, env=_SID
    )
    assert second.exit_code == 0, second.output
    payload = parse_cli_output(second.output)
    by_id = {r["dep_id"]: r["status"] for r in payload["results"]}
    assert by_id["fn-2-ad"] == "ALREADY_PRESENT"
    assert by_id["fn-3-ad"] == "WIRED"
    assert payload["depends_on_epics"] == ["fn-2-ad", "fn-3-ad"]


def test_add_deps_skip_invalid_statuses(tmp_path, monkeypatch):
    """--skip-invalid routes per-edge classifier errors into SKIPPED_* statuses
    rather than failing the call."""
    seed_state(tmp_path, epic_id="fn-1-si", n_tasks=1)
    seed_state(tmp_path, epic_id="fn-2-si", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    result = run_cli(
        [
            "epic",
            "add-deps",
            "fn-1-si",
            "fn-2-si",  # WIRED
            "not-an-id",  # SKIPPED_BAD_ID
            "fn-9-ghost",  # SKIPPED_NOT_FOUND
            "--skip-invalid",
        ],
        cwd=tmp_path,
        env=_SID,
    )
    assert result.exit_code == 0, result.output
    payload = parse_cli_output(result.output)
    by_id = {r["dep_id"]: r["status"] for r in payload["results"]}
    assert by_id["fn-2-si"] == "WIRED"
    assert by_id["not-an-id"] == "SKIPPED_BAD_ID"
    assert by_id["fn-9-ghost"] == "SKIPPED_NOT_FOUND"
    assert _epic_def(tmp_path, "fn-1-si")["depends_on_epics"] == ["fn-2-si"]


def test_add_deps_error_priority_bad_id_dominates(tmp_path, monkeypatch):
    """Without --skip-invalid the dominant error class is surfaced: a malformed
    id (bad_id) outranks a not-found dep."""
    seed_state(tmp_path, epic_id="fn-1-ep", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    result = run_cli(
        ["epic", "add-deps", "fn-1-ep", "not-an-id", "fn-9-ghost"],
        cwd=tmp_path,
        env=_SID,
    )
    assert result.exit_code == 1, result.output
    payload = parse_cli_output(result.output)
    assert payload["error"]["code"] == "bad_id"
    # No edge wired on the failure path.
    assert _epic_def(tmp_path, "fn-1-ep")["depends_on_epics"] == []


def test_add_deps_target_not_found_fails_loud_under_skip_invalid(tmp_path, monkeypatch):
    """--skip-invalid skips bad DEPS, but a missing TARGET epic still fails."""
    seed_state(tmp_path, epic_id="fn-1-tn", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    result = run_cli(
        ["epic", "add-deps", "fn-9-missing", "fn-1-tn", "--skip-invalid"],
        cwd=tmp_path,
        env=_SID,
    )
    assert result.exit_code == 1, result.output
    assert parse_cli_output(result.output)["error"]["code"] == "epic_not_found"


# ---------------------------------------------------------------------------
# epic rm-dep — idempotent
# ---------------------------------------------------------------------------


def test_rm_dep_removes_and_is_idempotent(tmp_path, monkeypatch, fixed_clock):
    seed_state(tmp_path, epic_id="fn-1-rd", n_tasks=1)
    seed_state(tmp_path, epic_id="fn-2-rd", n_tasks=1)
    monkeypatch.chdir(tmp_path)

    run_cli(["epic", "add-dep", "fn-1-rd", "fn-2-rd"], cwd=tmp_path, env=_SID)
    rm = run_cli(["epic", "rm-dep", "fn-1-rd", "fn-2-rd"], cwd=tmp_path, env=_SID)
    assert rm.exit_code == 0, rm.output
    assert _epic_def(tmp_path, "fn-1-rd")["depends_on_epics"] == []

    # Idempotent: removing a non-present dep is still success.
    again = run_cli(["epic", "rm-dep", "fn-1-rd", "fn-2-rd"], cwd=tmp_path, env=_SID)
    assert again.exit_code == 0, again.output
    assert _epic_def(tmp_path, "fn-1-rd")["depends_on_epics"] == []


# ---------------------------------------------------------------------------
# Cross-cutting: restamp-failure fail-forward (write lands, marker stale, exit 1)
# ---------------------------------------------------------------------------


def test_restamp_failure_is_fail_forward(tmp_path, monkeypatch):
    """A missing sibling-task spec fails the post-write integrity check: the
    verb emits the compact ``integrity_failed`` envelope and exits 1, but the
    structural write (the patched spec) STILL lands on disk and the marker is
    left stale (never re-stamped)."""
    seed_state(tmp_path, epic_id="fn-1-ff", n_tasks=2)
    # Corrupt the tree: delete task .2's spec so the post-write integrity check
    # raises a pinned "spec file missing" error (a deterministic integrity error
    # both engines detect identically).
    (tmp_path / ".planctl" / "specs" / "fn-1-ff.2.md").unlink()
    assert _epic_def(tmp_path, "fn-1-ff")["last_validated_at"] is None
    monkeypatch.chdir(tmp_path)

    result = run_cli(
        ["task", "set-description", "fn-1-ff.1"],
        cwd=tmp_path,
        env=_SID,
        input_text="forward write\n",
    )
    assert result.exit_code == 1, result.output
    payload = parse_cli_output(result.output)
    assert payload["success"] is False
    assert payload["error"]["code"] == "integrity_failed"
    assert "last_validated_at NOT re-stamped" in payload["error"]["message"]
    assert any("fn-1-ff.2" in d for d in payload["error"]["details"])

    # Fail-FORWARD: the structural write to .1's spec stayed on disk...
    assert "forward write" in _spec(tmp_path, "fn-1-ff.1")
    # ...and the marker was never re-stamped (still null).
    assert _epic_def(tmp_path, "fn-1-ff")["last_validated_at"] is None
