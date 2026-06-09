"""Native in-process trailer scan: find the commits carrying a ``Task:`` trailer.

A shared, verb-agnostic helper (sits alongside :mod:`planctl.commit` /
:mod:`planctl.ids`, not a ``run_*`` verb).  :func:`find_commit_groups` performs
the ``git log --grep`` + ``git interpret-trailers --parse`` archaeology over an
epic's resolved repo set and returns the grouped commit set the
``/plan:close`` quality-auditor reviews.

The contract is deliberately I/O-pure: the function returns data or raises a
typed exception — it never calls ``output.emit``, ``auto_commit``, or
``sys.exit``.  That keeps it importable from any verb (``run_close_preflight``
maps :class:`AllReposBrokenError` to its ``COMMIT_LOOKUP_FAILED`` envelope;
``run_reconcile`` consumes the same return-data / raise-typed seam).

Two-stage match, per scanned repo:

1. ``git log --grep="Task: <task_id>" -F --pretty=format:%H`` — ``-F`` is a
   fixed-string match (no regex), so ``^``/``$`` anchors are OMITTED; this is a
   loose pre-filter.
2. Per candidate SHA, ``git log -1 --format=%B <sha>`` piped via stdin to
   ``git interpret-trailers --parse`` confirms a REAL ``Task:`` trailer whose
   value equals ``<task_id>`` AND passes :func:`planctl.ids.is_task_id`.  This
   post-filter drops prose false-matches ("fixes the Task: fn-X issue").

A clean miss (no matching commit) is a normal empty result, never an error.
:class:`AllReposBrokenError` is raised ONLY when every listed repo is missing /
not a git repo — a single skipped repo emits a stderr note and the scan
continues.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from planctl.ids import is_task_id


class AllReposBrokenError(Exception):
    """Raised when every repo in the resolved scan set is missing or not a git repo.

    Carries the list of broken repo paths so the calling verb can surface them
    in its error envelope (``details={"broken_repos": [...]}``).  A scan set
    with even one usable repo never raises — broken entries are skipped with a
    stderr note.  An empty resolved scan set (``touched_repos == []``) is NOT a
    broken condition: it returns an empty result.
    """

    def __init__(self, broken_repos: list[str]) -> None:
        self.broken_repos = broken_repos
        super().__init__(
            "all repos in the scan set are missing or not git repos: "
            + ", ".join(broken_repos)
        )


def _resolve_repo_set(primary_repo: str, touched_repos: list[str] | None) -> list[str]:
    """Resolve the repo set from the ``touched_repos`` tri-state.

    - ``None`` / absent  → ``[primary_repo]`` (legacy / single-repo epic).
    - ``[]``             → ``[]`` (human set "scan nothing"; do NOT collapse to
      ``primary_repo``).
    - non-empty list     → each entry resolved to an absolute path.

    ``primary_repo`` is already an absolute resolved path (caller passes the
    line-236 value); ``touched_repos`` entries are resolved here.
    """
    if touched_repos is None:
        return [str(Path(primary_repo).resolve())]
    return [str(Path(r).resolve()) for r in touched_repos]


def _is_git_repo(repo: str) -> bool:
    """True iff *repo* is an existing dir containing a git repo."""
    if not Path(repo).is_dir():
        return False
    result = subprocess.run(
        ["git", "rev-parse", "--git-dir"],
        cwd=repo,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return result.returncode == 0


def _grep_candidates(task_id: str, repo: str) -> list[str]:
    """``git log --grep`` pre-filter (fixed-string). Returns candidate SHAs.

    ``-F`` disables regex, so no anchors. A non-zero exit (e.g. an unborn
    branch with no commits) yields an empty list — anchoring + confirmation is
    the post-filter's job, never the grep's.
    """
    result = subprocess.run(
        [
            "git",
            "log",
            f"--grep=Task: {task_id}",
            "-F",
            "--pretty=format:%H",
        ],
        cwd=repo,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if result.returncode != 0:
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def _load_trailers(sha: str, repo: str) -> dict[str, list[str]]:
    """Parse the trailers of *sha* into ``{key: [value, ...]}`` (multi-valued).

    Two git calls: ``git log -1 --format=%B <sha>`` fetches the raw body, piped
    via stdin to ``git interpret-trailers --parse`` (which strips prose, leaving
    only real ``Key: value`` trailer lines). Returns ``{}`` when either call
    exits non-zero or the parse output is empty/whitespace-only.

    Each output line is partitioned on the FIRST ``":"`` (so a value that itself
    contains a colon survives intact); both sides are stripped. Lines without a
    ``":"`` separator or with an empty key are skipped.
    """
    body = subprocess.run(
        ["git", "log", "-1", "--format=%B", sha],
        cwd=repo,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if body.returncode != 0:
        return {}

    parsed = subprocess.run(
        ["git", "interpret-trailers", "--parse"],
        input=body.stdout,
        cwd=repo,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if parsed.returncode != 0:
        return {}

    trailers: dict[str, list[str]] = {}
    for raw_line in parsed.stdout.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        sep = line.find(":")
        if sep < 0:
            continue
        key = line[:sep].strip()
        value = line[sep + 1 :].strip()
        if not key:
            continue
        trailers.setdefault(key, []).append(value)
    return trailers


def _has_real_task_trailer(sha: str, task_id: str, repo: str) -> bool:
    """Confirm a real ``Task: <task_id>`` trailer on *sha*.

    True iff some value in the commit's ``Task:`` trailer list equals
    *task_id* AND passes :func:`planctl.ids.is_task_id`. The ``is_task_id``
    gate drops a garbage trailer value before the membership test, so a prose
    false-match the ``-F`` grep let through can never spuriously confirm.
    """
    trailers = _load_trailers(sha, repo)
    for value in trailers.get("Task", []):
        if value == task_id and is_task_id(value):
            return True
    return False


def find_commit_groups(
    task_ids: list[str],
    primary_repo: str,
    touched_repos: list[str] | None,
) -> list[dict[str, object]]:
    """Find the source commits for *task_ids* grouped by repo.

    Scans the repo set resolved from the ``touched_repos`` tri-state (repo-outer,
    task-inner) for commits carrying a confirmed ``Task: <task_id>`` trailer, and
    returns ``[{"repo": <abs-path>, "shas": [...]}, ...]`` in repo-outer
    first-seen order (= ``touched_repos`` order). SHAs are deduped within a repo
    group (guards a commit carrying two ``Task:`` trailers or a repo listed
    twice). Full ``%H`` SHAs.

    A clean miss is a normal empty result. Raises :class:`AllReposBrokenError`
    only when EVERY resolved repo is missing or not a git repo; a single broken
    entry is skipped with a stderr note. An empty resolved set
    (``touched_repos == []``) returns ``[]`` and never raises.
    """
    repos = _resolve_repo_set(primary_repo, touched_repos)
    if not repos:
        return []

    # Defense-in-depth: reject any malformed task id before building argv.
    valid_task_ids = [tid for tid in task_ids if is_task_id(tid)]

    grouped: dict[str, list[str]] = {}
    order: list[str] = []
    broken: list[str] = []
    any_usable = False

    for repo in repos:
        if not _is_git_repo(repo):
            print(
                f"planctl.commit_lookup: skipping missing or non-git repo: {repo}",
                file=sys.stderr,
            )
            broken.append(repo)
            continue
        any_usable = True
        for task_id in valid_task_ids:
            for sha in _grep_candidates(task_id, repo):
                if not _has_real_task_trailer(sha, task_id, repo):
                    continue
                if repo not in grouped:
                    grouped[repo] = []
                    order.append(repo)
                if sha not in grouped[repo]:
                    grouped[repo].append(sha)

    if not any_usable:
        raise AllReposBrokenError(broken)

    return [{"repo": repo, "shas": grouped[repo]} for repo in order]


__all__ = (
    "AllReposBrokenError",
    "find_commit_groups",
)
