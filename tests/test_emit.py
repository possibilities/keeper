"""Tests for ``planctl.output.emit`` per-verb auto-commit (fn-587 task .2).

Covers the audit → commit → print reordering inside ``emit()``: every
mutating verb's success envelope on stdout is now an authoritative signal
that the ``.planctl/`` commit landed.  On commit failure, ``emit()`` prints
a structured ``commit_failed`` envelope and ``sys.exit(1)`` — the success
envelope is NOT printed.

Coverage matrix:

(a) happy path — files dirty → envelope ``success: true`` on stdout, HEAD
    advances by one commit carrying the payload subject, ``audit_row_id``-
    backfill hook fires.
(b) failure path — ``commit.auto_commit_from_invocation`` raises
    :class:`CommitFailed` → structured failure envelope on stdout, ``sys.exit(1)``,
    NO success envelope.
(c) no-op path — clean tree (no dirty files) → success envelope prints
    normally, no new commit, no error.
(d) ``audit_row_id`` absent → commit still lands (it's the authoritative
    state), backfill silently skipped (no error).

Plus a coverage line for the validate-marker subpath that bypasses
``emit()`` and wires ``commit.auto_commit_from_invocation`` in directly.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest
from click.testing import CliRunner
from planctl import commit as commit_module
from planctl.cli import cli

_ENV = {**os.environ, "CLAUDE_CODE_SESSION_ID": "test-emit-fixture"}


def _make_planctl_git_project(tmp_path, monkeypatch) -> Path:
    """Init a git repo + planctl project, commit baseline, and return the path.

    Differs from the shared ``planctl_git_repo`` fixture only in that we
    chdir + set ``CLAUDE_CODE_SESSION_ID`` here for click-runner invocations.
    """
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-emit-fixture")
    monkeypatch.chdir(tmp_path)

    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    for k, v in (
        ("user.email", "test@example.com"),
        ("user.name", "Test User"),
        ("commit.gpgsign", "false"),
        ("core.hooksPath", "/dev/null"),
    ):
        subprocess.run(
            ["git", "config", k, v], cwd=tmp_path, check=True, capture_output=True
        )

    (tmp_path / "README.md").write_text("# Test repo\n")
    subprocess.run(
        ["git", "add", "README.md"], cwd=tmp_path, check=True, capture_output=True
    )
    subprocess.run(
        ["git", "commit", "-m", "chore: initial commit"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
    )

    runner = CliRunner()
    result = runner.invoke(cli, ["init"], env=_ENV)
    assert result.exit_code == 0, result.output

    # Commit the planctl baseline so any subsequent verb starts on a clean tree.
    subprocess.run(
        ["git", "add", ".planctl/"], cwd=tmp_path, check=True, capture_output=True
    )
    subprocess.run(
        ["git", "commit", "-m", "chore: planctl init"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
    )
    return tmp_path


def _seed_epic(project_path: Path) -> tuple[str, str]:
    """Scaffold a small epic + one task; commit the resulting .planctl/ tree.

    Returns (epic_id, task_id).  Subsequent verb tests run against a clean
    worktree so any dirty state is attributable to the verb under test.

    fn-587 task .3: scaffold now stamps ``last_validated_at`` on the fresh
    epic JSON.  The validate-marker subpath tests below expect a never-
    stamped epic (so ``validate --epic`` triggers the None → timestamp
    transition that lands a fresh commit).  Null out the marker after the
    scaffold to restore that precondition without coupling those tests to
    scaffold's new stamping behaviour.
    """
    from .conftest import seed_epic

    epic_id, task_ids = seed_epic(
        project_path, title="emit test epic", n_tasks=1, env=_ENV
    )
    # Null multi-repo fields to keep the fixture light (no extra git roots),
    # and null last_validated_at so validate --epic still drives its marker-
    # write subpath when these tests need it.
    epic_path = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    data = json.loads(epic_path.read_text())
    data["primary_repo"] = None
    data["touched_repos"] = None
    data["last_validated_at"] = None
    epic_path.write_text(json.dumps(data))
    # Commit the freshly-scaffolded tree so we start the verb-under-test
    # with a clean worktree.
    subprocess.run(
        ["git", "add", ".planctl/"],
        cwd=project_path,
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "commit", "-m", "chore: seed planctl tree"],
        cwd=project_path,
        check=True,
        capture_output=True,
    )
    return epic_id, task_ids[0]


def _git_head_sha(repo: Path) -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def _git_head_subject(repo: Path) -> str:
    return subprocess.run(
        ["git", "log", "-1", "--format=%s"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def _git_commit_count(repo: Path) -> int:
    return int(
        subprocess.run(
            ["git", "rev-list", "--count", "HEAD"],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    )


def _parse_envelopes(output: str) -> list[dict]:
    """Parse every JSON object from CLI stdout (handles concatenated docs)."""
    decoder = json.JSONDecoder()
    docs: list[dict] = []
    idx = 0
    while idx < len(output):
        while idx < len(output) and output[idx] in " \t\n\r":
            idx += 1
        if idx >= len(output):
            break
        try:
            obj, end = decoder.raw_decode(output, idx)
        except json.JSONDecodeError:
            break
        if isinstance(obj, dict):
            docs.append(obj)
        idx = end
    return docs


# ---------------------------------------------------------------------------
# (a) happy path — envelope success + new HEAD commit + subject from payload
# ---------------------------------------------------------------------------


def test_emit_auto_commit_happy_path(tmp_path, monkeypatch):
    """A mutating verb landing dirty .planctl/ files emits success AND lands a commit.

    Canonical leak case: ``approve`` invoked outside any /plan:* skill.
    The envelope's ``success: true`` is the authoritative signal that the
    commit landed.

    Uses ``rejected`` so the fn-592 approve-gates (task→done /
    epic→done+all-tasks-done+all-tasks-approved) don't fire — this test
    cares about the emit / auto-commit boundary, not the approve gate.
    """
    project = _make_planctl_git_project(tmp_path, monkeypatch)
    epic_id, _ = _seed_epic(project)

    pre_count = _git_commit_count(project)

    runner = CliRunner()
    result = runner.invoke(cli, ["approve", epic_id, "rejected"], env=_ENV)
    assert result.exit_code == 0, result.output

    docs = _parse_envelopes(result.output)
    assert docs, f"no JSON envelopes in output: {result.output!r}"
    envelope = docs[0]
    assert envelope.get("success") is True, envelope
    assert envelope.get("approval") == "rejected"
    # Mutating verbs emit a single compact NDJSON envelope carrying
    # planctl_invocation merged in.
    assert "planctl_invocation" in envelope

    # HEAD advanced by exactly one commit.
    assert _git_commit_count(project) == pre_count + 1
    subject = _git_head_subject(project)
    assert subject == f"chore(planctl): approve {epic_id}", subject

    # Worktree clean for .planctl/ — no dirty files left behind.
    status = subprocess.run(
        ["git", "status", "--porcelain", "--", ".planctl/"],
        cwd=project,
        capture_output=True,
        text=True,
        check=True,
    )
    assert status.stdout.strip() == "", (
        f"approve left .planctl/ dirty: {status.stdout!r}"
    )


# ---------------------------------------------------------------------------
# (b) failure path — CommitFailed → structured failure envelope + exit 1
# ---------------------------------------------------------------------------


def test_emit_commit_failure_emits_structured_envelope_and_exits_1(
    tmp_path, monkeypatch
):
    """When ``commit.auto_commit_from_invocation`` raises, ``emit()`` prints
    a ``commit_failed`` envelope and exits 1.  The success envelope is NEVER
    printed.
    """
    project = _make_planctl_git_project(tmp_path, monkeypatch)
    epic_id, _ = _seed_epic(project)

    pre_count = _git_commit_count(project)

    def _boom(payload):
        raise commit_module.CommitFailed(
            "git_commit",
            "synthesized pre-commit-hook rejection",
            extra={"files": payload.get("files", [])},
        )

    monkeypatch.setattr(commit_module, "auto_commit_from_invocation", _boom)

    runner = CliRunner()
    # Use ``rejected`` so the fn-592 approve-gate doesn't fire — we want the
    # commit failure path, not the gate refusal path.
    result = runner.invoke(cli, ["approve", epic_id, "rejected"], env=_ENV)
    # exit 1 on commit failure (the success envelope contract).
    assert result.exit_code == 1, (
        f"expected exit 1 on commit failure, got {result.exit_code}: {result.output!r}"
    )

    docs = _parse_envelopes(result.output)
    # First envelope MUST be the failure envelope.  No success envelope
    # may appear at all.
    success_envelopes = [
        d for d in docs if d.get("success") is True and "planctl_invocation" in d
    ]
    assert success_envelopes == [], (
        f"success envelope must NOT appear on commit failure: {success_envelopes}"
    )

    failure = next((d for d in docs if d.get("success") is False), None)
    assert failure is not None, f"missing failure envelope in {result.output!r}"
    assert failure["error"] == "commit_failed"
    assert failure["details"]["error"] == "git_commit"
    assert "synthesized" in failure["details"]["message"]
    assert "planctl_invocation" in failure

    # No new HEAD commit landed.
    assert _git_commit_count(project) == pre_count


# ---------------------------------------------------------------------------
# (c) no-op path — files=[] (runtime-state-only mutation): no commit, success
# ---------------------------------------------------------------------------


def test_emit_no_op_clean_tree_still_prints_success(tmp_path, monkeypatch):
    """A verb whose payload carries files=[] (no dirty .planctl/) prints
    its success envelope and never creates a commit.

    ``planctl claim`` is the canonical runtime-state-only verb: it writes
    only to gitignored ``.planctl/state/``, so the touched ∩ dirty
    intersection is empty.
    """
    project = _make_planctl_git_project(tmp_path, monkeypatch)
    epic_id, task_id = _seed_epic(project)

    pre_count = _git_commit_count(project)

    runner = CliRunner()
    result = runner.invoke(
        cli,
        ["claim", task_id, "--project", str(project)],
        env=_ENV,
    )
    assert result.exit_code == 0, result.output

    docs = _parse_envelopes(result.output)
    success_envelope = next((d for d in docs if d.get("success") is True), None)
    assert success_envelope is not None, (
        f"missing success envelope in: {result.output!r}"
    )
    # files=None or []: either way, commit.auto_commit_from_invocation
    # short-circuits into the no-op path (no commit attempt).  Runtime-
    # state-only verbs typically emit files=None.
    inv = success_envelope.get("planctl_invocation", {})
    assert not inv.get("files"), f"expected falsy files, got: {inv.get('files')!r}"

    # No new commit landed.
    assert _git_commit_count(project) == pre_count, (
        f"runtime-state-only verb must not create a commit; "
        f"head went from {pre_count} to {_git_commit_count(project)}"
    )


# ---------------------------------------------------------------------------
# (d) audit_row_id absent — commit still lands, no backfill error
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# validate --epic marker-write subpath also auto-commits inline
# ---------------------------------------------------------------------------


def test_validate_emit_bypass_auto_commits(tmp_path, monkeypatch):
    """``validate --epic <id>`` bypasses ``output.emit()`` to keep its
    non-standard ``{valid, errors, warnings}`` envelope intact.  Task .2
    wires ``commit.auto_commit_from_invocation`` into the marker-write
    subpath directly — the epic JSON commits inline alongside the
    ``planctl_invocation`` NDJSON line.
    """
    project = _make_planctl_git_project(tmp_path, monkeypatch)
    epic_id, _ = _seed_epic(project)

    pre_count = _git_commit_count(project)

    # First validate — marker is None → stamped → committed inline.
    result = subprocess.run(
        ["planctl", "validate", "--epic", epic_id],
        cwd=project,
        env=_ENV,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"validate failed: {result.stdout}\n{result.stderr}"

    # HEAD advanced.
    assert _git_commit_count(project) == pre_count + 1, (
        f"validate --epic must commit on marker stamp; "
        f"head went from {pre_count} to {_git_commit_count(project)}"
    )
    subject = _git_head_subject(project)
    assert subject == f"chore(planctl): validate {epic_id}", subject

    # The epic JSON commit must contain the new last_validated_at value.
    epic_path = project / ".planctl" / "epics" / f"{epic_id}.json"
    data = json.loads(epic_path.read_text())
    assert data.get("last_validated_at") is not None

    # Re-run validate: marker already stamped → no second commit, no
    # planctl_invocation line in output.
    result2 = subprocess.run(
        ["planctl", "validate", "--epic", epic_id],
        cwd=project,
        env=_ENV,
        capture_output=True,
        text=True,
    )
    assert result2.returncode == 0
    assert _git_commit_count(project) == pre_count + 1


def test_validate_emit_bypass_commit_failure_aborts_invocation_line(
    tmp_path, monkeypatch
):
    """If the validate marker-write commit fails, ``run_validate`` prints a
    ``commit_failed`` envelope and exits 1 — the ``planctl_invocation``
    NDJSON line is NOT printed.
    """
    project = _make_planctl_git_project(tmp_path, monkeypatch)
    epic_id, _ = _seed_epic(project)

    # Patch the in-process commit helper so a direct CliRunner invocation
    # forces the failure branch.  Subprocess invocation can't see the
    # monkeypatch, so we drive validate through CliRunner here.
    def _boom(payload):
        raise commit_module.CommitFailed(
            "git_commit", "synthesized validate-marker rejection"
        )

    monkeypatch.setattr(commit_module, "auto_commit_from_invocation", _boom)

    runner = CliRunner()
    result = runner.invoke(cli, ["validate", "--epic", epic_id], env=_ENV)
    assert result.exit_code == 1, (
        f"expected exit 1 on validate-marker commit failure, "
        f"got {result.exit_code}: {result.output!r}"
    )

    docs = _parse_envelopes(result.output)
    # The first doc is the {valid, errors, warnings} envelope printed
    # BEFORE the marker write.  The next doc must be the failure envelope
    # — no planctl_invocation envelope (no NDJSON line) should appear.
    invocation_lines = [d for d in docs if set(d.keys()) == {"planctl_invocation"}]
    assert invocation_lines == [], (
        f"validate must not print the planctl_invocation NDJSON line on "
        f"commit failure: {result.output!r}"
    )

    failure = next((d for d in docs if d.get("success") is False), None)
    assert failure is not None, f"missing commit_failed envelope in: {result.output!r}"
    assert failure["error"] == "commit_failed"
    assert failure["details"]["error"] == "git_commit"
    assert "synthesized" in failure["details"]["message"]


# ---------------------------------------------------------------------------
# Negative: read-only verb path is unchanged (no commit attempt at all)
# ---------------------------------------------------------------------------


def test_emit_read_only_path_never_attempts_commit(tmp_path, monkeypatch):
    """``emit(data)`` with no ``planctl_invocation`` (read-only verb internal
    call) goes through ``format_output`` and never invokes the commit
    helper.

    Read-only verbs route through the click decorator's
    ``_emit_readonly_invocation`` path instead, which also never calls
    ``commit.auto_commit_from_invocation``.  Smoke check that ``status``
    on a clean tree never creates a commit and never triggers commit
    helper code.
    """
    project = _make_planctl_git_project(tmp_path, monkeypatch)
    _seed_epic(project)

    commit_calls = {"n": 0}

    real_auto_commit = commit_module.auto_commit_from_invocation

    def _counting_auto_commit(payload):
        commit_calls["n"] += 1
        return real_auto_commit(payload)

    monkeypatch.setattr(
        commit_module, "auto_commit_from_invocation", _counting_auto_commit
    )

    pre_count = _git_commit_count(project)

    runner = CliRunner()
    result = runner.invoke(cli, ["status"], env=_ENV)
    assert result.exit_code == 0, result.output

    assert _git_commit_count(project) == pre_count
    assert commit_calls["n"] == 0, (
        f"status (read-only) must never call auto_commit_from_invocation; "
        f"got {commit_calls['n']} calls"
    )


# ---------------------------------------------------------------------------
# Regression — the approve leak case (the canonical fix)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("from_any_cwd", [True, False])
def test_approve_from_any_cwd_leaves_planctl_clean(tmp_path, monkeypatch, from_any_cwd):
    """The canonical leak case: ``approve`` invoked from a non-project cwd
    (or from inside the project) must commit its ``.planctl/`` write inline.
    Both invocation forms leave ``.planctl/`` clean after exit.

    Uses ``rejected`` so the fn-592 approve-gate doesn't fire — we want the
    commit-leak coverage, not the gate behavior.
    """
    project = _make_planctl_git_project(tmp_path, monkeypatch)
    epic_id, _ = _seed_epic(project)

    # `approve` resolves the project via roots discovery, not via cwd — so a
    # cwd outside the project is the leak case the fix targets.
    cwd = tmp_path if from_any_cwd else project

    result = subprocess.run(
        ["planctl", "approve", epic_id, "rejected"],
        cwd=cwd,
        env=_ENV,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"approve failed: {result.stdout}\n{result.stderr}"

    status = subprocess.run(
        ["git", "status", "--porcelain", "--", ".planctl/"],
        cwd=project,
        capture_output=True,
        text=True,
        check=True,
    )
    assert status.stdout.strip() == "", (
        f"approve left .planctl/ dirty after exit: {status.stdout!r}"
    )
