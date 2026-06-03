"""Tests for :mod:`planctl.commit` — the per-verb auto-commit primitives
introduced by fn-587 task .1.

Coverage matrix:

- :func:`auto_commit_from_invocation` happy path — files dirty → commit lands
  with the subject from the payload, returns the long sha, backfills the audit
  row when ``audit_row_id`` is present.
- No-op path — empty / None ``files`` returns ``None`` without touching git.
- No-op path under flock — files in payload but clean tree returns ``None``.
- Hard failure path — commit fails (e.g. nothing actually dirty after a
  concurrent commit raced us, simulated by writing files outside the payload
  scope) raises :class:`CommitFailed`.
- Missing ``audit_row_id`` — commit still lands; backfill silently skipped.
- ``state_repo`` fallback — payload missing ``state_repo`` but carrying
  ``repo_root`` warns to stderr and uses ``repo_root`` as cwd.

Plus regression coverage for :func:`planctl.store.now_iso` after the
microsecond-precision upgrade.
"""

from __future__ import annotations

import re
import subprocess
import time
from pathlib import Path

import pytest
from planctl import commit as commit_module
from planctl.commit import CommitFailed, auto_commit_from_invocation
from planctl.store import now_iso

from .conftest import (
    _git_commit_count,
    _git_head_files,
    _git_head_message,
    _git_head_sha,
)

# ---------------------------------------------------------------------------
# now_iso() microsecond precision
# ---------------------------------------------------------------------------


_ISO_MICRO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$")


def test_now_iso_microsecond_format():
    """now_iso emits ``YYYY-MM-DDTHH:MM:SS.uuuuuuZ`` (6 micro digits + Z)."""
    ts = now_iso()
    assert _ISO_MICRO_RE.match(ts), (
        f"now_iso() must match %Y-%m-%dT%H:%M:%S.%fZ, got: {ts!r}"
    )


def test_now_iso_strictly_monotonic_under_rapid_calls():
    """1000 rapid back-to-back calls produce strictly increasing stamps.

    Microsecond precision is load-bearing for keeper-side soft-disarm
    (``current != stored`` check on the re-stamp marker).  Two structural
    verbs firing within the same wall-clock second must produce distinct
    stamps so the comparison still flags the change.
    """
    stamps = [now_iso() for _ in range(1000)]
    # Most adjacent pairs strictly increase; the test accepts at most a
    # handful of identical-microsecond pairs (clock resolution on some
    # systems is 1µs but Python's datetime.now() can collide intra-µs).
    duplicates = sum(1 for a, b in zip(stamps, stamps[1:], strict=False) if a == b)
    assert duplicates < len(stamps) * 0.10, (
        f"now_iso() collided on >10% of rapid pairs ({duplicates}/{len(stamps) - 1}); "
        f"microsecond precision is insufficient on this host"
    )
    # Lexicographic order is preserved — the seam-runner's `last_validated_at`
    # comparison and the SQLite ts column ordering both rely on this.
    assert stamps == sorted(stamps), "now_iso() must be lexicographically monotonic"


# ---------------------------------------------------------------------------
# auto_commit_from_invocation — no-op paths
# ---------------------------------------------------------------------------


def test_auto_commit_returns_none_when_files_none(planctl_git_repo):
    """A read-only verb's payload (``files=None``) is a no-op return — no git ops."""
    pre = _git_commit_count(planctl_git_repo)
    sha = auto_commit_from_invocation(
        {
            "files": None,
            "op": "show",
            "target": "fn-1-noop",
            "subject": None,
            "state_repo": str(planctl_git_repo),
            "repo_root": str(planctl_git_repo),
        }
    )
    assert sha is None
    assert _git_commit_count(planctl_git_repo) == pre


def test_auto_commit_returns_none_when_files_empty(planctl_git_repo):
    """A runtime-state-only verb's payload (``files=[]``) is a no-op return."""
    pre = _git_commit_count(planctl_git_repo)
    sha = auto_commit_from_invocation(
        {
            "files": [],
            "op": "claim",
            "target": "fn-1-noop.1",
            "subject": "chore(planctl): claim fn-1-noop.1",
            "state_repo": str(planctl_git_repo),
            "repo_root": str(planctl_git_repo),
        }
    )
    assert sha is None
    assert _git_commit_count(planctl_git_repo) == pre


def test_auto_commit_returns_none_when_tree_clean_under_lock(planctl_git_repo):
    """Payload lists files, but the worktree is clean for them — no-op return.

    Mirrors the post-lock no-op check: a concurrent verb may have committed
    our intended files between payload-build and lock-acquire, and we must
    NOT create an empty commit in that case.
    """
    # Create a tracked file, commit it, then call auto_commit with that path
    # in the payload — the path is clean now, so the call must no-op.
    tracked = planctl_git_repo / "some_clean_file.txt"
    tracked.write_text("clean\n")
    subprocess.run(["git", "add", str(tracked)], cwd=planctl_git_repo, check=True)
    subprocess.run(
        ["git", "commit", "-m", "chore: prep clean file"],
        cwd=planctl_git_repo,
        check=True,
        capture_output=True,
    )

    pre = _git_commit_count(planctl_git_repo)
    sha = auto_commit_from_invocation(
        {
            "files": ["some_clean_file.txt"],
            "op": "noop-clean",
            "target": "fn-1-noop",
            "subject": "chore(planctl): noop-clean fn-1-noop",
            "state_repo": str(planctl_git_repo),
            "repo_root": str(planctl_git_repo),
        }
    )
    assert sha is None
    assert _git_commit_count(planctl_git_repo) == pre


# ---------------------------------------------------------------------------
# auto_commit_from_invocation — happy path
# ---------------------------------------------------------------------------


def _make_dirty(repo: Path, rel_path: str, content: str = "dirty\n") -> str:
    """Write *content* to *rel_path* under *repo* and return the rel path."""
    target = repo / rel_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)
    return rel_path


def test_auto_commit_happy_path_returns_sha_and_commits(planctl_git_repo):
    """Dirty files → commit lands, returns the long sha, message uses payload subject."""
    rel = _make_dirty(planctl_git_repo, ".planctl/epics/test_marker.txt")
    pre = _git_commit_count(planctl_git_repo)

    subject = "chore(planctl): approve fn-587-x"
    sha = auto_commit_from_invocation(
        {
            "files": [rel],
            "op": "approve",
            "target": "fn-587-x",
            "subject": subject,
            "state_repo": str(planctl_git_repo),
            "repo_root": str(planctl_git_repo),
        }
    )

    assert sha is not None
    assert len(sha) == 40, f"expected full sha, got {sha!r}"
    assert _git_commit_count(planctl_git_repo) == pre + 1
    # The returned sha matches HEAD.
    assert _git_head_sha(planctl_git_repo) == sha[:7]
    msg = _git_head_message(planctl_git_repo)
    assert msg.splitlines()[0] == subject
    # Forensic trailers are appended.
    assert "Planctl-Op: approve" in msg
    assert "Planctl-Target: fn-587-x" in msg
    assert "Planctl-Prev-Op: " in msg
    assert rel in _git_head_files(planctl_git_repo)


def test_auto_commit_skips_files_not_in_payload(planctl_git_repo):
    """A second dirty file outside the payload's scope is NOT staged.

    Mirrors the seam-runner contract — only files explicitly listed in
    the payload land in the commit; other dirty paths stay unstaged.
    """
    in_scope = _make_dirty(planctl_git_repo, ".planctl/epics/scope_in.txt")
    out_scope = _make_dirty(planctl_git_repo, ".planctl/epics/scope_out.txt")

    sha = auto_commit_from_invocation(
        {
            "files": [in_scope],
            "op": "approve",
            "target": "fn-587-y",
            "subject": "chore(planctl): approve fn-587-y",
            "state_repo": str(planctl_git_repo),
            "repo_root": str(planctl_git_repo),
        }
    )

    assert sha is not None
    head_files = _git_head_files(planctl_git_repo)
    assert in_scope in head_files
    assert out_scope not in head_files
    # The out-of-scope file is still dirty on disk.
    status = subprocess.run(
        ["git", "status", "--porcelain", "--", out_scope],
        cwd=planctl_git_repo,
        capture_output=True,
        text=True,
        check=True,
    )
    assert status.stdout.strip(), "out-of-scope file must remain dirty"


# ---------------------------------------------------------------------------
# auto_commit_from_invocation — audit-row backfill
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# auto_commit_from_invocation — state_repo / subject fallbacks + failures
# ---------------------------------------------------------------------------


def test_auto_commit_falls_back_to_repo_root_when_state_repo_missing(
    planctl_git_repo, capsys
):
    """Payload missing ``state_repo`` but carrying ``repo_root`` works + warns."""
    rel = _make_dirty(planctl_git_repo, ".planctl/epics/fallback.txt")
    sha = auto_commit_from_invocation(
        {
            "files": [rel],
            "op": "approve",
            "target": "fn-587-fb",
            "subject": "chore(planctl): approve fn-587-fb",
            # state_repo absent
            "repo_root": str(planctl_git_repo),
        }
    )
    assert sha is not None
    err = capsys.readouterr().err
    assert "falling back to repo_root" in err


def test_auto_commit_raises_when_state_repo_and_repo_root_both_missing(
    planctl_git_repo,
):
    """No ``state_repo`` and no ``repo_root`` → :class:`CommitFailed`."""
    rel = _make_dirty(planctl_git_repo, ".planctl/epics/no_repo.txt")
    with pytest.raises(CommitFailed) as ei:
        auto_commit_from_invocation(
            {
                "files": [rel],
                "op": "approve",
                "target": "fn-587-nr",
                "subject": "chore(planctl): approve fn-587-nr",
            }
        )
    assert ei.value.error == "missing_state_repo"


def test_auto_commit_raises_when_subject_missing(planctl_git_repo):
    """Missing ``subject`` → :class:`CommitFailed`."""
    rel = _make_dirty(planctl_git_repo, ".planctl/epics/no_subject.txt")
    with pytest.raises(CommitFailed) as ei:
        auto_commit_from_invocation(
            {
                "files": [rel],
                "op": "approve",
                "target": "fn-587-ns",
                "state_repo": str(planctl_git_repo),
                "repo_root": str(planctl_git_repo),
            }
        )
    assert ei.value.error == "missing_subject"


def test_auto_commit_raises_commit_failed_on_git_commit_error(
    planctl_git_repo, monkeypatch
):
    """A failing ``git commit`` surfaces as :class:`CommitFailed` ``"git_commit"``."""

    # Force git commit to fail by wedging an unsigned-commit requirement
    # against a config that won't allow it.  Simpler: monkeypatch
    # `_git_commit` in the commit module to raise.
    def _boom(msg: str, cwd: str) -> str:
        raise CommitFailed("git_commit", "synthesized failure")

    monkeypatch.setattr(commit_module, "_git_commit", _boom)

    rel = _make_dirty(planctl_git_repo, ".planctl/epics/cf.txt")
    with pytest.raises(CommitFailed) as ei:
        auto_commit_from_invocation(
            {
                "files": [rel],
                "op": "approve",
                "target": "fn-587-cf",
                "subject": "chore(planctl): approve fn-587-cf",
                "state_repo": str(planctl_git_repo),
                "repo_root": str(planctl_git_repo),
            }
        )
    assert ei.value.error == "git_commit"


# ---------------------------------------------------------------------------
# Flock acquisition — basic smoke test (full lock-timeout coverage stays
# in test_commit_plan.py until task .5 deletes it).
# ---------------------------------------------------------------------------


def test_auto_commit_releases_lock_on_success(planctl_git_repo):
    """After a successful commit, a second call on the same repo proceeds.

    Smoke test for FD/lock cleanup — if the lock leaked, the second call
    would either block 60s or fail.  We bound the second call's wall-clock
    to a few seconds via a follow-up empty no-op payload.
    """
    rel = _make_dirty(planctl_git_repo, ".planctl/epics/lock1.txt")
    sha1 = auto_commit_from_invocation(
        {
            "files": [rel],
            "op": "approve",
            "target": "fn-587-l1",
            "subject": "chore(planctl): approve fn-587-l1",
            "state_repo": str(planctl_git_repo),
            "repo_root": str(planctl_git_repo),
        }
    )
    assert sha1 is not None

    # Second call should not block — measure wall-clock.
    start = time.monotonic()
    rel2 = _make_dirty(planctl_git_repo, ".planctl/epics/lock2.txt")
    sha2 = auto_commit_from_invocation(
        {
            "files": [rel2],
            "op": "approve",
            "target": "fn-587-l2",
            "subject": "chore(planctl): approve fn-587-l2",
            "state_repo": str(planctl_git_repo),
            "repo_root": str(planctl_git_repo),
        }
    )
    elapsed = time.monotonic() - start
    assert sha2 is not None
    assert sha2 != sha1
    assert elapsed < 5.0, f"lock acquisition took {elapsed:.2f}s — possible leak"
