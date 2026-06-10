"""Invocation payload builder for planctl CLI invocations.

Mutating verbs call ``build_planctl_invocation(verb, target_id, ...)`` to build
the ``planctl_invocation`` envelope payload.  The hook registered in
``apps/hookctl/hooks/planctl-mutation/`` consumes this payload and commits the
``.planctl/`` state — the CLI itself no longer shells out to git.

Read-only verbs (and the click decorator path) call
``build_planctl_invocation_readonly(verb, target_id, ...)`` to build a
lighter-weight payload with NULL ``subject``, ``files``, and ``commit_sha``.
The hook INSERTs a row and emits to UDS but skips the git commit step.

Commit message format (produced by the hook for mutating verbs)::

    chore(planctl): <verb> <id>[ — <detail>]

    Planctl-Op: <verb>
    Planctl-Target: <id>
    Planctl-Prev-Op: <sha of HEAD captured BEFORE git commit>
    Session-Id: <CLAUDE_CODE_SESSION_ID>   (omitted when the env var is absent)

Envelope fields (mutating verbs):
    repo_root   — the cwd-derived repo at invocation time (always present).
    state_repo  — the repo whose .planctl/ carries state for this epic/task.
                  Populated from epic.primary_repo when the verb targets an
                  epic/task; falls back to repo_root for cwd-only verbs (init,
                  detect).  The hook uses state_repo when present to route the
                  commit to the correct .planctl/ directory.  Both fields are
                  always emitted; they are equal for single-repo projects.
"""

from __future__ import annotations

import os
from pathlib import Path


def _planctl_dir(repo_root: Path) -> Path:
    """Resolve the .planctl/ directory relative to repo_root."""
    return repo_root / ".planctl"


def build_planctl_invocation(
    verb: str,
    target_id: str,
    detail: str | None = None,
    *,
    repo_root: Path,
    primary_repo: str | None = None,
    queue_jump: bool = False,
) -> dict:
    """Build the ``planctl_invocation`` envelope payload for a mutating verb.

    This payload is injected into the JSON envelope by ``output.emit()`` so
    that downstream hooks can parse it and commit the ``.planctl/`` state
    without the CLI needing to shell out to git itself.

    Parameters
    ----------
    verb:
        Canonical verb name registered in ``commit_messages.VERB_TEMPLATES``.
    target_id:
        Epic or task ID that was mutated.
    detail:
        Optional short detail appended after em-dash in the subject.
    repo_root:
        Project root (directory containing ``.planctl/`` and ``.git``).
        Semantics: the cwd-derived repo at invocation time.
    primary_repo:
        The repo whose ``.planctl/`` carries the state for this epic/task.
        Populated from ``epic.primary_repo`` for verbs targeting an epic/task;
        defaults to ``None`` (falls back to ``repo_root`` in the envelope).
    queue_jump:
        Whether the epic requested a priority jump. Two sources set
        True: a ``scaffold`` whose epic YAML opts in (``queue_jump: true``),
        and the ``epic queue-jump`` verb (``/plan:next``) flipping an existing
        epic. The field is server-derived from the epic record — keeperd lifts
        it off this envelope into ``epics.queue_jump`` and derives the
        ``!``-prefixed ``sort_path``. Old envelopes lacking the key fold to
        False deterministically (``?? false`` on the keeper side).

    Returns
    -------
    dict
        Payload with keys: ``files``, ``op``, ``target``, ``subject``,
        ``touched_path_files``, ``repo_root``, ``state_repo``, ``queue_jump``,
        ``session_id``.
    """
    from planctl.commit_messages import build_subject
    from planctl.store import _read_touched_files

    planctl_dir = _planctl_dir(repo_root)

    # Resolve session id — CLAUDE_CODE_SESSION_ID is the sole source. Fail
    # closed on None: the claude binary ships this intrinsically on every
    # session (including resumed ones), so it is always present for a planctl
    # mutating verb invocation inside a Claude harness.
    session_id = os.environ.get("CLAUDE_CODE_SESSION_ID") or None
    if session_id is None:
        raise RuntimeError(
            "planctl build_planctl_invocation requires a resolvable session_id; "
            "CLAUDE_CODE_SESSION_ID must be set (the claude binary ships it "
            "intrinsically inside a Claude harness; tests and manual invocations "
            "must set it themselves)."
        )

    # Touched files record paths (for hook cleanup, G7).
    touched_path_files = _read_touched_files(planctl_dir, session_id)

    # Touched paths → intersect with dirty set.
    touched = _read_touched_paths(repo_root, session_id)
    dirty = _dirty_planctl_paths(repo_root)
    files = sorted(p for p in touched if p in dirty)

    subject = build_subject(verb, target_id, detail)

    # state_repo: where .planctl/ state lives.
    # primary_repo (from epic.primary_repo) takes precedence; falls back to
    # repo_root for verbs that have no epic/task target.
    state_repo = primary_repo if primary_repo is not None else str(repo_root)

    return {
        "files": files,
        "op": verb,
        "target": target_id,
        "subject": subject,
        "touched_path_files": touched_path_files,
        "repo_root": str(repo_root),
        "state_repo": state_repo,
        "queue_jump": queue_jump,
        # The resolved committing session id, threaded into the
        # `chore(planctl)` commit's `Session-Id` trailer by
        # `auto_commit_from_invocation`. Same opaque v4 UUID the keeper hook
        # uses (job_id === session_id). Always populated here — the resolve
        # above fails closed for mutating verbs.
        "session_id": session_id,
    }


def _read_touched_paths(repo_root: Path, session_id: str) -> list[str]:
    """Return paths recorded for *session_id* in the touched-paths log.

    Each path is a POSIX string relative to *repo_root*, starting with
    ``.planctl/``.  Paths that fail validation (``..``, non-``.planctl/``
    prefix) are rejected with a ``RuntimeError`` rather than silently dropped
    — a bad path means a bug upstream and should be loud.
    """
    planctl_dir = _planctl_dir(repo_root)
    touched_dir = planctl_dir / "state" / "sessions" / session_id / "touched"
    if not touched_dir.exists():
        return []

    paths: list[str] = []
    for txt in touched_dir.glob("*.txt"):
        raw = txt.read_text(encoding="utf-8").strip()
        if not raw:
            continue
        # Security: reject traversal and non-.planctl/ paths.
        if ".." in raw.split("/"):
            raise RuntimeError(
                f"Touched-paths record contains path traversal: {raw!r} "
                f"(file: {txt}). This is a bug — report it."
            )
        if not raw.startswith(".planctl/"):
            raise RuntimeError(
                f"Touched-paths record contains non-.planctl/ path: {raw!r} "
                f"(file: {txt}). This is a bug — report it."
            )
        paths.append(raw)
    return paths


def build_planctl_invocation_readonly(
    verb: str,
    target_id: str | None = None,
    *,
    repo_root: Path,
) -> dict:
    """Build a read-only ``planctl_invocation`` envelope payload.

    Used by the click decorator for verbs that don't mutate ``.planctl/``
    state (show, cat, validate, list, etc.).  Skips the touched-paths log read
    and git dirty-set intersection — read-only verbs touch nothing.

    The hook INSERTs a row with NULL ``subject``, ``files``, and ``commit_sha``
    and emits an audit row, but skips the git commit step.

    Parameters
    ----------
    verb:
        Canonical verb name (e.g. ``"show"``, ``"cat"``, ``"list"``).
    target_id:
        Epic or task ID, or None when the verb has no target (e.g. ``"list"``).
    repo_root:
        Project root (directory containing ``.planctl/`` and ``.git``).

    Returns
    -------
    dict
        Payload with: ``op``, ``target``, ``subject=None``, ``files=None``,
        ``touched_path_files=[]``, ``repo_root``, ``state_repo``.
    """
    repo_root_str = str(repo_root)
    return {
        "files": None,
        "op": verb,
        "target": target_id,
        "subject": None,
        "touched_path_files": [],
        "repo_root": repo_root_str,
        "state_repo": repo_root_str,
    }


def _dirty_planctl_paths(repo_root: Path) -> set[str]:
    """Return the set of dirty (modified/untracked) .planctl/ paths from git.

    Uses ``--untracked-files=all`` so new files appear individually rather than
    as directory-level ``??`` entries — without this, freshly-written files that
    have never been committed show up as ``?? .planctl/epics/`` instead of
    ``?? .planctl/epics/fn-1-test.json`` and the touched-path intersection
    returns an empty set.
    """
    import subprocess

    result = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=all", "--", ".planctl/"],
        cwd=str(repo_root),
        capture_output=True,
        text=True,
    )
    paths: set[str] = set()
    for line in result.stdout.splitlines():
        if len(line) < 4:
            continue
        # git status --porcelain: XY <path> (first 3 chars are status + space)
        rel = line[3:].strip()
        # Handle renames: "old -> new" format
        if " -> " in rel:
            rel = rel.split(" -> ", 1)[1]
        if rel:
            paths.add(rel)
    return paths
