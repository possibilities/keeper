"""Per-verb auto-commit machinery for planctl ``.planctl/`` state.

Every mutating planctl verb's stdout envelope carries a ``planctl_invocation``
payload (see ``planctl.invocation.build_planctl_invocation``).  The runner-side
``emit()`` calls :func:`auto_commit_from_invocation` to land the corresponding
``chore(planctl): <op> <target>`` commit inline, under the
``$GIT_COMMON_DIR/planctl-commit.lock`` flock.  Replaces the deleted seven-seam
``planctl commit-plan`` model (fn-488 → fn-587).

This module exposes one public entry point — :func:`auto_commit_from_invocation`.
The flock + git plumbing was originally copied from
``jobctl/run_commit_work.py::_acquire_commit_lock``; planctl now owns its own
lock file (``planctl-commit.lock``) since the two sides stage disjoint
pathspecs (planctl: ``.planctl/`` only; jobctl: excludes ``.planctl/``).
"""

from __future__ import annotations

import fcntl
import os
import subprocess
import sys
import time
from typing import Any

# How long to spin waiting for the commit lock (seconds).  Same value as
# ``jobctl/run_commit_work.py::_LOCK_TIMEOUT_SECONDS`` so starvation
# diagnostics surface with the same envelope shape on either side.
_LOCK_TIMEOUT_SECONDS = 60


class CommitFailed(Exception):
    """Raised when :func:`auto_commit_from_invocation` hits a hard failure.

    Carries structured failure details so the caller (``output.emit`` post-
    task-.2) can re-shape them into the JSON failure envelope without parsing
    a free-form message.

    Attributes:
        error: Short error code (``"lock_timeout"``, ``"git_add"``,
            ``"git_commit"``, ``"git_status"``).
        message: Human-readable detail (verbatim stderr where applicable).
        extra: Optional structured fields (e.g. ``holder_pid`` for
            lock_timeout).
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
# Flock — planctl-owned at $GIT_COMMON_DIR/planctl-commit.lock.
# ---------------------------------------------------------------------------


def _git_common_dir(cwd: str) -> str:
    """Return the git common dir (shared across worktrees; same as .git in
    non-worktrees).

    Mirrors ``jobctl/run_commit_work.py::_git_common_dir`` so the lock path
    resolution is byte-identical with jobctl's (independent file, same dir).
    """
    result = subprocess.run(
        ["git", "rev-parse", "--git-common-dir"],
        cwd=cwd,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip() if result.returncode == 0 else ".git"


def _acquire_commit_lock(lock_path: str) -> int:
    """Acquire LOCK_EX on *lock_path* with a 60-second timeout.

    Returns the open file descriptor (caller must close / release).  The FD
    is ``O_CLOEXEC`` so child processes (git) don't inherit it.

    On timeout, reads the lockfile to surface holder PID/cmdline and raises
    :class:`CommitFailed` with ``error="lock_timeout"``.  Verbatim behavioural
    mirror of ``jobctl/run_commit_work.py::_acquire_commit_lock`` — kept in
    sync so diagnostics shape is consistent across the two independent locks.
    """
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o644)

    deadline = time.monotonic() + _LOCK_TIMEOUT_SECONDS
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            # Lock acquired — write holder info so waiters can diagnose timeout.
            pid = os.getpid()
            cmdline: str
            try:
                # Linux: /proc/<pid>/cmdline is null-separated argv.
                with open(f"/proc/{pid}/cmdline", "rb") as f:
                    cmdline = (
                        f.read().replace(b"\x00", b" ").decode(errors="replace").strip()
                    )
            except Exception:
                # macOS / BSD: no procfs — ask `ps` for the command.  Falls
                # back to sys.argv if even ps fails so we always have
                # *something* identifying the holder.
                try:
                    ps_result = subprocess.run(
                        ["ps", "-p", str(pid), "-o", "command="],
                        capture_output=True,
                        text=True,
                        timeout=2,
                    )
                    cmdline = ps_result.stdout.strip() or " ".join(sys.argv)
                except Exception:
                    cmdline = " ".join(sys.argv)
            os.ftruncate(fd, 0)
            os.lseek(fd, 0, os.SEEK_SET)
            os.write(fd, f"pid={pid}\ncmdline={cmdline}\n".encode())
            return fd
        except OSError:
            if time.monotonic() >= deadline:
                # Read current holder info from lockfile for diagnostics.
                holder_pid: int | None = None
                holder_cmdline: str | None = None
                try:
                    os.lseek(fd, 0, os.SEEK_SET)
                    contents = os.read(fd, 4096).decode(errors="replace")
                    for line in contents.splitlines():
                        if line.startswith("pid="):
                            holder_pid = int(line[4:].strip())
                        elif line.startswith("cmdline="):
                            holder_cmdline = line[8:].strip()
                except Exception:
                    pass
                os.close(fd)
                raise CommitFailed(
                    "lock_timeout",
                    f"timed out waiting {_LOCK_TIMEOUT_SECONDS}s for "
                    f"{lock_path} (holder pid={holder_pid})",
                    extra={
                        "holder_pid": holder_pid,
                        "holder_cmdline": holder_cmdline,
                        "lock_path": lock_path,
                    },
                ) from None
            time.sleep(0.1)


def _release_commit_lock(fd: int) -> None:
    """Release the flock and close the FD."""
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


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


def _git_commit(msg: str, cwd: str) -> str:
    """Commit whatever is currently staged with *msg*.  Returns the full SHA.

    Uses ``git commit -F -`` (message via stdin) for injection-safety.
    Returns the long sha so downstream consumers (keeper's commit
    attribution, log scans) see the canonical full-length identifier.

    Raises :class:`CommitFailed` with ``error="git_commit"`` on failure
    (e.g. pre-commit hook rejection, empty tree, signing failure).
    """
    commit_result = subprocess.run(
        ["git", "commit", "-F", "-"],
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
    """Commit ``payload['files']`` under the planctl commit flock.

    Returns the commit SHA on success, ``None`` on the no-op-clean path
    (no dirty files in scope), and raises :class:`CommitFailed` on any
    hard failure (lock timeout, git status / add / commit error).

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

    The git commit lands under ``LOCK_EX`` on
    ``$GIT_COMMON_DIR/planctl-commit.lock``, so concurrent planctl verbs
    on the same host serialise cleanly.  The lock is no longer shared
    with ``jobctl commit-work`` — pathspecs are disjoint (planctl stages
    ``.planctl/`` only; jobctl excludes it) and git's own ``index.lock``
    guards simultaneous index writes.
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

    # Acquire the per-repo commit lock.  planctl-owned (not shared with
    # `jobctl commit-work`) — pathspecs are disjoint and git's own
    # `index.lock` guards simultaneous index writes.
    git_common = _git_common_dir(state_repo)
    if not os.path.isabs(git_common):
        git_common = os.path.join(state_repo, git_common)
    lock_path = os.path.join(git_common, "planctl-commit.lock")

    lock_fd = _acquire_commit_lock(lock_path)
    try:
        # Re-confirm dirtiness under the lock — a concurrent verb may have
        # already committed our files between payload-build and lock-acquire.
        # Intersect payload['files'] with what git reports dirty now.
        dirty = _dirty_files_for_pathspecs(list(files), state_repo)
        if not dirty:
            return None

        prev_sha = _current_head(state_repo)
        msg = _build_message_with_trailers(subject, op, target, prev_sha)

        _git_stage(dirty, state_repo)
        new_sha = _git_commit(msg, state_repo)
    finally:
        _release_commit_lock(lock_fd)

    return new_sha


__all__ = (
    "CommitFailed",
    "auto_commit_from_invocation",
)
