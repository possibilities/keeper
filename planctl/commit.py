"""Per-verb auto-commit machinery for planctl ``.planctl/`` state.

Every mutating planctl verb's stdout envelope carries a ``planctl_invocation``
payload (see ``planctl.invocation.build_planctl_invocation``).  The runner-side
``emit()`` calls :func:`auto_commit_from_invocation` to land the corresponding
``chore(planctl): <op> <target>`` commit inline.  Replaces the deleted
seven-seam ``planctl commit-plan`` model (fn-488 → fn-587).

This module exposes one public entry point — :func:`auto_commit_from_invocation`.
There is no flock: each commit is pathspec-scoped to its own exact files
(``git commit -F - -- <files>``), so concurrent same-repo verbs never
cross-contaminate, and a bounded full-jitter retry handles the two git lock
domains (``index.lock`` for staging, ref-lock for the commit) by re-running
add+commit from the current HEAD each attempt (fn-640).
"""

from __future__ import annotations

import random
import subprocess
import sys
import time
from typing import Any

# Bounded retry over git's own lock domains (index.lock + ref-lock).  Sized so
# the worst case (8 × 2s cap ≈ 16s) fits the 30s xdist test timeout with
# margin.  Full-jitter backoff: ``delay = random(0, min(cap, base * 2**n))``.
_RETRY_MAX_ATTEMPTS = 8
_RETRY_BASE_SECONDS = 0.1
_RETRY_CAP_SECONDS = 2.0


class CommitFailed(Exception):
    """Raised when :func:`auto_commit_from_invocation` hits a hard failure.

    Carries structured failure details so the caller (``output.emit`` post-
    task-.2) can re-shape them into the JSON failure envelope without parsing
    a free-form message.

    Attributes:
        error: Short error code (``"commit_contended"``, ``"git_add"``,
            ``"git_commit"``, ``"git_status"``).
        message: Human-readable detail (verbatim stderr where applicable).
        extra: Optional structured fields.
    """

    def __init__(
        self,
        error: str,
        message: str,
        *,
        extra: dict[str, Any] | None = None,
    ) -> None:
        self.error = error
        self.message = message
        self.extra = extra or {}
        super().__init__(f"{error}: {message}")


# ---------------------------------------------------------------------------
# git plumbing — current head, status filter, stage, commit.
# ---------------------------------------------------------------------------


def _current_head(cwd: str) -> str:
    """Return the current HEAD sha, or ``"unknown"`` on failure.

    Matches the legacy post-hook's ``_current_head`` sentinel so trailer
    forensics on a corrupted HEAD render the same string across both
    code paths.
    """
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=cwd,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip() if result.returncode == 0 else "unknown"


def _dirty_files_for_pathspecs(pathspecs: list[str], cwd: str) -> list[str]:
    """Return repo-relative paths under *pathspecs* that have changes git
    would stage (either unstaged-but-modified OR already-staged-but-not-
    committed).

    Uses ``git status --porcelain=v1 -- <pathspecs>`` rather than walking
    the worktree so submodules, gitignored paths, and pathspec
    interpretation match the eventual ``git add`` exactly.

    Returns an empty list when nothing is dirty — callers use that to
    short-circuit into the no-op path without creating an empty commit.

    Raises :class:`CommitFailed` with ``error="git_status"`` on a
    non-zero exit (rare; pathspecs are constructed mechanically).
    """
    result = subprocess.run(
        ["git", "status", "--porcelain=v1", "--", *pathspecs],
        cwd=cwd,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise CommitFailed(
            "git_status",
            f"git status failed: {result.stderr.strip()}",
        )
    files: list[str] = []
    for line in result.stdout.splitlines():
        if len(line) < 4:
            continue
        # Porcelain v1: ``XY <path>`` where X is index status and Y is
        # worktree status.  Either non-space means git has something to
        # stage or commit.  Rename lines (``R  old -> new``) are not
        # produced by typical .planctl/ writes (atomic rename of tmpfile
        # to final shows as ``M`` after the first commit), so we ignore
        # the rename-arrow split — the path-as-printed is what gets
        # passed back to ``git add`` and that DTRT.
        path = line[3:].strip()
        if path:
            files.append(path)
    return files


def _git_stage(files: list[str], cwd: str) -> None:
    """Stage *files* (``git add -- <files>``).

    Files are already filtered to the dirty subset — we never pass raw
    pathspec wildcards to ``git add`` here, only concrete paths, so
    cross-epic / cross-task leakage cannot occur.

    Raises :class:`CommitFailed` with ``error="git_add"`` on failure.
    """
    add_result = subprocess.run(
        ["git", "add", "--", *files],
        cwd=cwd,
        capture_output=True,
        text=True,
    )
    if add_result.returncode != 0:
        raise CommitFailed(
            "git_add",
            f"git add failed: {add_result.stderr.strip()}",
            extra={"files": files},
        )


def _git_commit(msg: str, files: list[str], cwd: str) -> str:
    """Commit *files* with *msg* (pathspec-scoped).  Returns the full SHA.

    Uses ``git commit -F - -- <files>`` (message via stdin for
    injection-safety; trailing pathspec to scope the commit).  The pathspec
    builds the committed tree from HEAD plus exactly the listed paths, so a
    concurrent sibling's staged-but-unrelated files never leak into this
    commit even when both verbs share one index.  Returns the long sha so
    downstream consumers (keeper's commit attribution, log scans) see the
    canonical full-length identifier.

    Raises :class:`CommitFailed` with ``error="git_commit"`` on failure
    (e.g. pre-commit hook rejection, empty tree, signing failure, ref-lock
    contention).  Ref-lock contention is distinguished by the caller via
    :func:`_is_commit_contention` and retried, not surfaced.
    """
    commit_result = subprocess.run(
        ["git", "commit", "-F", "-", "--", *files],
        input=msg,
        cwd=cwd,
        capture_output=True,
        text=True,
    )
    if commit_result.returncode != 0:
        raise CommitFailed(
            "git_commit",
            f"git commit failed: {commit_result.stderr.strip()}",
        )

    sha_result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=cwd,
        capture_output=True,
        text=True,
    )
    return sha_result.stdout.strip()


# ---------------------------------------------------------------------------
# Contention detection — match git's lock-domain stderr, not exit codes.
# ---------------------------------------------------------------------------
#
# Two distinct git lock domains can transiently lose a race against a
# concurrent same-repo verb:
#
#   * the index lock (``.git/index.lock``) — guards ``git add`` / index
#     writes; a loser sees ``Unable to create '<...>/index.lock': File
#     exists``.
#   * the ref lock (``.git/refs/...`` / ``packed-refs.lock``) — guards the
#     final ref update inside ``git commit``; a loser sees ``cannot lock
#     ref 'HEAD'`` (or a packed-refs variant).
#
# We match on the verbatim stderr substrings rather than git's numeric exit
# codes: those codes are not stable across git versions, and matching them
# would risk retrying genuine failures (hook rejection, signing, empty tree)
# which must surface immediately.


def _is_stage_contention(message: str) -> bool:
    """True when *message* is an ``index.lock`` race (retryable stage loss)."""
    return "index.lock" in message or "File exists" in message


def _is_commit_contention(message: str) -> bool:
    """True when *message* is a ref-lock race (retryable commit loss).

    A ref-lock loser must NOT naively retry the bare ``git commit`` — that
    would leave a second dangling commit off the stale parent.  The retry
    re-runs add+commit from the current HEAD so the new commit re-parents off
    the winner's tip; pathspec-scoping makes that merge-free.
    """
    return "cannot lock ref" in message


# ---------------------------------------------------------------------------
# Commit message composition — subject from payload + forensic trailers.
# ---------------------------------------------------------------------------


def _build_message_with_trailers(
    subject: str, op: str, target: str, prev_op_sha: str
) -> str:
    """Build the full commit message with the three forensic trailers.

    Trailers:
      ``Planctl-Op: <op>``            — verb that fired (envelope ``op``)
      ``Planctl-Target: <id>``        — entity the verb was scoped to
      ``Planctl-Prev-Op: <sha>``      — HEAD before this commit (forensics
                                        continuity; matches the legacy
                                        post-hook's ``Planctl-Prev-Op``)
    """
    return (
        f"{subject}\n"
        f"\n"
        f"Planctl-Op: {op}\n"
        f"Planctl-Target: {target}\n"
        f"Planctl-Prev-Op: {prev_op_sha}\n"
    )


# ---------------------------------------------------------------------------
# Public entry point.
# ---------------------------------------------------------------------------


def auto_commit_from_invocation(payload: dict[str, Any]) -> str | None:
    """Commit ``payload['files']`` (pathspec-scoped, with a bounded retry).

    Returns the commit SHA on success, ``None`` on the no-op-clean path
    (no dirty files in scope), and raises :class:`CommitFailed` on any
    hard failure (git status / add / commit error, or
    ``"commit_contended"`` on retry exhaustion).

    *payload* is the ``planctl_invocation`` envelope dict built by
    :func:`planctl.invocation.build_planctl_invocation`.  Relevant fields:

    - ``files``: list of repo-relative paths the verb intends to commit
      (touched ∩ dirty intersection, pre-computed).  ``None`` or ``[]``
      → no-op return.
    - ``subject``: pre-built ``chore(planctl): <op> <target>`` line from
      ``commit_messages.build_subject``.  Used verbatim.
    - ``op`` / ``target``: forensic trailer values.
    - ``state_repo``: the cwd for git operations — the repo whose
      ``.planctl/`` carries the state.  Falls back to ``repo_root`` with
      a stderr warning when absent or stale (older envelope shapes).

    There is no flock.  Each commit is scoped to its own exact paths via
    ``git commit -F - -- <files>``, so two same-repo verbs sharing one index
    never cross-contaminate (the loser's staged files never leak into the
    winner's commit).  The two git lock domains that can transiently lose a
    race — the index lock (stage) and the ref lock (commit) — are absorbed
    by a bounded full-jitter retry that re-runs the FULL ``git add`` +
    ``git commit`` from the current HEAD each attempt.  Re-reading HEAD inside
    the retried body is the keystone: a ref-lock loser re-parents off the
    winner's tip (safe — disjoint pathspec-scoped files need no merge) and
    the ``Planctl-Prev-Op`` trailer reflects the FINAL parent.  Retry fires
    ONLY on contention stderr; a genuine failure (hook reject, signing,
    empty tree) surfaces immediately.  On exhaustion:
    ``CommitFailed("commit_contended", ...)``.
    """
    files = payload.get("files")
    if not files:
        # No-op: read-only verb (files=None), runtime-state-only verb
        # (files=[]), or no dirty intersection.  Never create an empty
        # commit.
        return None

    # state_repo precedence: explicit field → repo_root fallback (older
    # envelope shapes).  Emit a stderr warning on the fallback so envelope-shape
    # drift is visible without flipping the success path.
    state_repo = payload.get("state_repo")
    if not isinstance(state_repo, str) or not state_repo:
        repo_root = payload.get("repo_root")
        if isinstance(repo_root, str) and repo_root:
            print(
                "planctl.commit: payload missing state_repo, falling back to "
                f"repo_root={repo_root!r}",
                file=sys.stderr,
            )
            state_repo = repo_root
        else:
            raise CommitFailed(
                "missing_state_repo",
                "planctl_invocation payload lacks both state_repo and repo_root",
            )

    subject = payload.get("subject")
    if not isinstance(subject, str) or not subject:
        raise CommitFailed(
            "missing_subject",
            "planctl_invocation payload lacks a subject for the commit",
        )

    op = payload.get("op", "")
    target = payload.get("target") or ""

    # No flock.  Run the dirty-confirm → stage → commit sequence under a
    # bounded full-jitter retry over git's own lock domains.  Each attempt
    # re-runs the FULL add+commit from current HEAD — a ref-lock loser must
    # re-parent off the winner's tip, never write a second dangling commit.
    files = list(files)
    for attempt in range(_RETRY_MAX_ATTEMPTS):
        try:
            # Re-confirm dirtiness each attempt — a concurrent verb may have
            # already committed our files (harmless under pathspec-scoping,
            # but short-circuits into the no-op path instead of an empty
            # commit / spurious hook-reject retry).  Intersect payload['files']
            # with what git reports dirty now.
            dirty = _dirty_files_for_pathspecs(files, state_repo)
            if not dirty:
                return None

            # Re-read HEAD inside the retried body so the Planctl-Prev-Op
            # trailer reflects the FINAL parent after a ref-lock re-parent.
            prev_sha = _current_head(state_repo)
            msg = _build_message_with_trailers(subject, op, target, prev_sha)

            _git_stage(dirty, state_repo)
            return _git_commit(msg, dirty, state_repo)
        except CommitFailed as exc:
            stage_contended = exc.error == "git_add" and _is_stage_contention(
                exc.message
            )
            commit_contended = exc.error == "git_commit" and _is_commit_contention(
                exc.message
            )
            if not (stage_contended or commit_contended):
                # Genuine failure (hook reject, signing, empty tree, real
                # add/status error) — surface immediately, never mask it.
                raise
            if attempt == _RETRY_MAX_ATTEMPTS - 1:
                raise CommitFailed(
                    "commit_contended",
                    f"git lock contention persisted across "
                    f"{_RETRY_MAX_ATTEMPTS} attempts: {exc.message}",
                ) from exc
            # Full-jitter backoff before re-running add+commit from HEAD.
            delay = random.uniform(
                0.0,
                min(_RETRY_CAP_SECONDS, _RETRY_BASE_SECONDS * (2**attempt)),
            )
            time.sleep(delay)

    # Unreachable — the loop either returns or raises on the final attempt.
    raise CommitFailed(
        "commit_contended",
        f"git lock contention persisted across {_RETRY_MAX_ATTEMPTS} attempts",
    )


__all__ = (
    "CommitFailed",
    "auto_commit_from_invocation",
)
