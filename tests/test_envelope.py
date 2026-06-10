"""Tests for planctl mutating-verb envelope shape (fn-64-rework-planctl-commit-behavior.3).

The CLI no longer commits — the hookctl planctl-mutation hook is the sole commit
actor.  These tests verify:

  - Mutating verbs emit a valid ``planctl_invocation`` payload in the envelope
  - The payload has the expected shape (files, op, target, subject, touched_path_files)
  - Runtime-only verbs do NOT emit ``planctl_invocation``
  - Non-mutating verbs do NOT emit ``planctl_invocation``
  - Peer-session files stay out of the ``files`` list (regression guard)
  - Session-id None raises RuntimeError in build_planctl_invocation
  - no-git: mutation succeeds with planctl_invocation emitted (files may be empty)
  - planctl done always emits planctl_invocation
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest
from click.testing import CliRunner
from planctl.cli import cli

from .conftest import _git_log_count

# This file pins the commit-at-mutation-boundary envelope: it stages real files
# to drive the touched∩dirty intersection that populates ``files`` / ``subject``
# and counts real commits landed by each mutating verb's auto-commit. The real
# git status+add+commit cycle IS the subject, so the whole file is ``real_git``
# (slow bucket: no autocommit/dirty-probe stubs, real ``git init`` + commits).
pytestmark = pytest.mark.real_git

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _invoke(args: list[str], env: dict | None = None):
    runner = CliRunner()
    if env:
        full_env = {**os.environ, **env}
        return runner.invoke(cli, args, env=full_env)
    return runner.invoke(cli, args)


def _commit_count(repo: Path) -> int:
    return _git_log_count(repo)


def _parse_envelope(output: str) -> dict:
    """Parse NDJSON or JSON envelope from CLI output."""
    # Mutating verbs emit compact single-line JSON (NDJSON); take first line.
    first_line = output.strip().splitlines()[0]
    return json.loads(first_line)


# ---------------------------------------------------------------------------
# Happy path: epic create emits planctl_invocation payload
# ---------------------------------------------------------------------------


def test_epic_create_emits_planctl_mutation(planctl_git_repo):
    r = _invoke(["epic", "create", "--title", "Test epic"])
    assert r.exit_code == 0, r.output
    payload = _parse_envelope(r.output)

    assert payload["success"] is True
    pc = payload.get("planctl_invocation")
    assert pc is not None, "mutating verb must carry planctl_invocation"

    # Shape checks
    assert pc["op"] == "create"
    assert pc["target"].startswith("fn-")
    assert pc["subject"].startswith("chore(planctl): create fn-")
    assert isinstance(pc["files"], list)
    assert isinstance(pc["touched_path_files"], list)
    # All declared files must be within .planctl/
    for f in pc["files"]:
        assert f.startswith(".planctl/"), f"non-.planctl/ file in payload: {f}"


# ---------------------------------------------------------------------------
# planctl done always emits planctl_invocation
# ---------------------------------------------------------------------------


def test_done_emits_planctl_mutation(planctl_git_repo):
    from .conftest import seed_epic

    _epic_id, task_ids = seed_epic(planctl_git_repo, title="E", n_tasks=1)
    task_id = task_ids[0]
    # --project bypasses roots discovery (fn-542 task .3): claim is cwd-agnostic.
    _invoke(["claim", task_id, "--force", "--project", str(planctl_git_repo)])

    r = _invoke(["done", task_id, "--summary", "done", "--force"])
    assert r.exit_code == 0, r.output
    payload = _parse_envelope(r.output)

    pc = payload.get("planctl_invocation")
    assert pc is not None, "planctl done must carry planctl_invocation"

    assert pc["op"] == "done"
    assert pc["target"] == task_id


# ---------------------------------------------------------------------------
# no-git: mutation succeeds, planctl_invocation emitted (files may be empty)
# ---------------------------------------------------------------------------


def test_no_git_repo(tmp_path, monkeypatch):
    """In a directory without git, mutations succeed and still emit planctl_invocation."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-session-no-git")
    runner = CliRunner()
    r = runner.invoke(cli, ["init"])
    assert r.exit_code == 0, r.output

    r = runner.invoke(cli, ["epic", "create", "--title", "No git"])
    assert r.exit_code == 0, r.output
    payload = _parse_envelope(r.output)
    assert payload["success"] is True
    # planctl_invocation is still present; files list will be empty (no git dirty set)
    assert "planctl_invocation" in payload


# ---------------------------------------------------------------------------
# claim is runtime-state-only: emits readonly planctl_invocation shape
# ---------------------------------------------------------------------------


def test_claim_emits_planctl_invocation_readonly(planctl_git_repo):
    from .conftest import seed_epic

    _epic_id, task_ids = seed_epic(planctl_git_repo, title="Runtime test", n_tasks=1)
    task_id = task_ids[0]

    # --project bypasses roots discovery (fn-542 task .3): claim is cwd-agnostic.
    r = _invoke(["claim", task_id, "--force", "--project", str(planctl_git_repo)])
    assert r.exit_code == 0, r.output
    payload = _parse_envelope(r.output)
    pc = payload.get("planctl_invocation")
    assert pc is not None, "claim must emit planctl_invocation"
    assert pc["op"] == "claim"
    assert pc["target"] == task_id
    assert pc["subject"] is None, "claim is runtime-state-only: subject must be None"
    assert pc["files"] is None, "claim is runtime-state-only: files must be None"


# ---------------------------------------------------------------------------
# Dirty non-planctl tree: payload files must NOT include src/foo.py
# ---------------------------------------------------------------------------


def test_dirty_tree_excluded_from_planctl_mutation_files(planctl_git_repo):
    repo = planctl_git_repo

    # Stage a file outside .planctl/
    src_dir = repo / "src"
    src_dir.mkdir()
    foo = src_dir / "foo.py"
    foo.write_text("x = 1\n")
    subprocess.run(["git", "add", "src/foo.py"], cwd=repo, check=True)

    r = _invoke(["epic", "create", "--title", "Dirty tree test"])
    assert r.exit_code == 0, r.output

    payload = _parse_envelope(r.output)
    files = payload["planctl_invocation"]["files"]
    assert all(f.startswith(".planctl/") for f in files), (
        f"planctl_invocation.files contains non-.planctl/ paths: {files}"
    )


# ---------------------------------------------------------------------------
# Peer-session exclusion: peer session file must not appear in files list
# ---------------------------------------------------------------------------


def test_peer_session_excluded_from_planctl_mutation_files(
    planctl_git_repo, monkeypatch
):
    """A dirty .planctl/ file written by a *different* session must not appear
    in this session's planctl_invocation.files."""
    repo = planctl_git_repo

    # Session A: create an epic (records paths under test-session-fixture).
    r = _invoke(["epic", "create", "--title", "Session A epic"])
    assert r.exit_code == 0, r.output
    epic_id = _parse_envelope(r.output)["epic"]["id"]

    # Simulate a peer session (session B) by writing a file directly without
    # going through atomic_write's recorder.
    peer_file = repo / ".planctl" / "epics" / "fn-peer-inject.json"
    peer_file.parent.mkdir(parents=True, exist_ok=True)
    peer_file.write_text('{"id": "fn-peer-inject", "status": "open"}\n')
    subprocess.run(["git", "add", str(peer_file)], cwd=repo, check=True)

    # Trigger a new mutation in session A.
    r = _invoke(["epic", "set-title", epic_id, "--title", "Session A renamed"])
    assert r.exit_code == 0, r.output
    payload = _parse_envelope(r.output)

    files = payload["planctl_invocation"]["files"]
    assert not any("fn-peer-inject" in f for f in files), (
        f"peer session file leaked into session A planctl_invocation.files: {files}"
    )


# ---------------------------------------------------------------------------
# Session-id None raises RuntimeError in build_planctl_mutation
# ---------------------------------------------------------------------------


def test_session_id_none_raises(planctl_git_repo, monkeypatch):
    """build_planctl_invocation must raise RuntimeError when CLAUDE_CODE_SESSION_ID is unset.

    The env var is the sole source — no process-tree fallback.
    """
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)

    from planctl.invocation import build_planctl_invocation
    from planctl.project import resolve_project

    ctx = resolve_project()
    with pytest.raises(RuntimeError, match="CLAUDE_CODE_SESSION_ID"):
        build_planctl_invocation("create", "fn-test", repo_root=ctx.project_path)


def test_build_invocation_carries_session_id(planctl_git_repo, monkeypatch):
    """fn-695: the envelope carries session_id == CLAUDE_CODE_SESSION_ID verbatim.

    The auto-commit reads this off the payload to stamp the Session-Id trailer;
    it must be the same opaque uuid the launcher exported, not a fresh one.
    """
    sid = "deadbeef-0000-4000-8000-000000000001"
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", sid)

    from planctl.invocation import build_planctl_invocation
    from planctl.project import resolve_project

    ctx = resolve_project()
    pc = build_planctl_invocation("create", "fn-test", repo_root=ctx.project_path)
    assert pc["session_id"] == sid


# ---------------------------------------------------------------------------
# Multiple mutating verbs all emit planctl_invocation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "verb_args",
    [
        ["epic", "set-branch", "{epic_id}", "--branch", "test-branch"],
        ["epic", "set-title", "{epic_id}", "--title", "New title"],
        ["epic", "close", "{epic_id}", "--force"],
    ],
)
def test_epic_verbs_emit_planctl_mutation(planctl_git_repo, verb_args):
    r = _invoke(["epic", "create", "--title", "Param epic"])
    epic_id = _parse_envelope(r.output)["epic"]["id"]

    args = [a.replace("{epic_id}", epic_id) for a in verb_args]
    r = _invoke(args)
    assert r.exit_code == 0, f"verb {args!r} failed: {r.output}"

    payload = _parse_envelope(r.output)
    pc = payload.get("planctl_invocation")
    assert pc is not None, f"verb {args!r} must emit planctl_invocation"
    assert isinstance(pc["files"], list)
    assert isinstance(pc["subject"], str)
    assert pc["subject"].startswith("chore(planctl):")


# ---------------------------------------------------------------------------
# Click decorator: read-only verbs emit planctl_invocation as trailing NDJSON
# ---------------------------------------------------------------------------


def _split_output(output: str) -> tuple[dict, dict | None]:
    """Split CLI output into (primary_payload, trailing_invocation | None).

    The primary payload may be pretty-printed multi-line JSON; the trailing
    planctl_invocation envelope (if any) is the last compact NDJSON line.
    """
    lines = output.strip().splitlines()
    # Find the last line that contains a planctl_invocation key.
    inv_line = None
    primary_lines = []
    for ln in lines:
        stripped = ln.strip()
        if stripped and stripped.startswith('{"planctl_invocation"'):
            inv_line = stripped
        else:
            primary_lines.append(ln)
    primary = json.loads("\n".join(primary_lines)) if primary_lines else {}
    trailing = json.loads(inv_line) if inv_line else None
    return primary, trailing


def test_readonly_verbs_emit_invocation_via_decorator(planctl_git_repo):
    """Read-only verbs emit a trailing planctl_invocation NDJSON line.

    The primary JSON payload does NOT have a ``planctl_invocation`` key — it
    is emitted as a separate compact line after the primary output.
    The decorator's planctl_invocation has ``subject=None`` and ``files=None``.
    """
    r = _invoke(["epic", "create", "--title", "Read-only test"])
    epic_id = _parse_envelope(r.output)["epic"]["id"]

    for args in [
        ["show", epic_id],
        ["epics"],
        ["status"],
    ]:
        r = _invoke(args)
        assert r.exit_code == 0, f"{args!r} failed: {r.output}"
        primary, trailing = _split_output(r.output)
        assert trailing is not None, (
            f"read-only verb {args!r} must emit trailing planctl_invocation line"
        )
        pc = trailing["planctl_invocation"]
        assert pc["subject"] is None, (
            f"read-only invocation must have subject=None: {pc}"
        )
        assert pc["files"] is None, f"read-only invocation must have files=None: {pc}"
        assert "planctl_invocation" not in primary, (
            f"primary payload for {args!r} must not embed planctl_invocation"
        )


def test_mutating_verbs_no_double_emit(planctl_git_repo):
    """Mutating verbs must NOT double-emit: the decorator sentinel prevents
    a second planctl_invocation after the verb's own emit."""
    r = _invoke(["epic", "create", "--title", "Double-emit test"])
    assert r.exit_code == 0, r.output
    lines = [ln for ln in r.output.strip().splitlines() if ln.strip()]
    # Mutating verb: only one line (compact NDJSON with planctl_invocation embedded)
    invocation_lines = [ln for ln in lines if "planctl_invocation" in ln]
    assert len(invocation_lines) == 1, (
        f"mutating verb must emit exactly one planctl_invocation line, "
        f"got {len(invocation_lines)}: {invocation_lines}"
    )
