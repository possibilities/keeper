"""Orphan-epic reaper — sweep stale, unowned, untracked epic trees (fn-629 task .4).

Background
----------

A hard ``commit_failed`` envelope at the central seam (``output.emit``) leaves
the written epic tree on disk per the §10 no-rollback policy. The fn-629
keeper-side observation gate (task .1) prevents a worker from ever being
dispatched against such a tree, but planctl carries the complementary
sweep-it-up half: the next mutating verb on a planctl project removes any
epic tree that is fully written to its final paths but never made it into
git. This module is that sweep.

What is an "orphan epic"?
-------------------------

A file at ``.planctl/epics/<id>.json`` that is **git-untracked** — i.e.
``git ls-files --error-unmatch -- <path>`` exits non-zero. If the file is
tracked (even with uncommitted modifications), it is not an orphan; the
tracked state is authoritative.

Safety gate — the whole reason this module exists
-------------------------------------------------

The reap window is precisely the fn-627 incident window. A concurrent
session that has just finished Phase 4 of ``scaffold`` (writes landed,
commit not yet executed) has, on disk, an untracked epic tree that the
reaper MUST NOT touch. Reaping it would re-create the orphan-dispatch bug
in reverse: a legitimate live commit racing a delete from a sibling
session.

The gate is two conjoined predicates — **both** must hold before reap:

1. **Stale by mtime.** The epic JSON's mtime is older than
   ``_REAP_MIN_AGE_SECONDS`` (default 5 minutes). Any in-flight write is
   sub-second; a 5-minute floor is conservative beyond any commit-lock
   timeout (60s) plus realistic clock skew.
2. **No live session owns it.** No file under
   ``.planctl/state/sessions/<sid>/touched/`` has been modified within
   ``_LIVE_SESSION_WINDOW_SECONDS`` (default 10 minutes). The touched-paths
   log is written by every ``atomic_write`` / ``_record_touched`` call,
   so a freshly-running session leaves recent timestamps regardless of
   whether the specific touched-path file names the orphan epic. The
   coarse "is any session active" predicate is intentional — naming-
   specific matching (touched-log line names the orphan JSON) would race
   the write that creates the touched-record itself, and the cost of
   waiting another verb-cycle to reap is zero.

When in doubt: do NOT reap. The reaper is invoked at the next mutating
verb anyway, so a skipped pass costs nothing.

Fail-soft contract
------------------

Reap errors NEVER propagate. The reaper runs as a pre-flight at the top
of ``scaffold`` / ``refine-apply`` Phase 3; an exception here would block
the actual mutation, exactly the failure mode we are protecting against.
Every failure path is logged-and-swallowed.

Idempotency
-----------

Re-running the reaper on the same project is a no-op: the second pass
finds no untracked epic JSONs because the first pass unlinked them.
Concurrent reapers (two mutating verbs racing the pre-flight) are
mutually safe — each ``os.unlink`` is naturally idempotent
(``FileNotFoundError`` is swallowed), and the per-path
``_record_touched`` + ``unlink`` ordering matches ``run_epic_rm``.
"""

from __future__ import annotations

import contextlib
import re
import subprocess
import sys
import time
from pathlib import Path

# How old (in seconds) the orphan's epic JSON must be before we reap it.
# Conservative: 5 minutes is well beyond any in-flight write window
# (sub-second) plus the 60s commit-lock timeout plus realistic clock skew.
# Lower bound on a real orphan from a hard commit_failed: the moment the
# commit failed, the file's mtime stopped advancing — so wall-clock now
# minus that mtime grows monotonically. There is no upper bound; an old
# orphan never becomes un-reapable.
_REAP_MIN_AGE_SECONDS = 5 * 60

# How recently a session must have been active (any touched-record mtime)
# to count as live and veto a reap. 10 minutes is a generous window —
# long enough to cover a Claude turn that's spent the last few minutes
# in tool calls between two scaffold sub-steps, short enough that
# truly-abandoned sessions don't strand orphans forever.
_LIVE_SESSION_WINDOW_SECONDS = 10 * 60

# Traversal guard: only filename-safe characters in an epic_id derived
# from a stem. Mirrors `run_epic_rm._EPIC_ID_PATH_RE` so the reaper's
# stem-derived id can never break out of `.planctl/`.
_EPIC_ID_PATH_RE = re.compile(r"^[A-Za-z0-9_\-]+$")


def _log_skip(reason: str) -> None:
    """Stderr-log a skip so reap decisions are visible without breaking stdout."""
    with contextlib.suppress(Exception):
        print(f"planctl.reaper: skip — {reason}", file=sys.stderr)


def _is_tracked(path: Path, repo_root: Path) -> bool | None:
    """Return True if *path* is tracked in git, False if untracked, None on error.

    Uses ``git ls-files --error-unmatch -- <path>``: exits 0 if tracked,
    non-zero otherwise. A git-subprocess failure (no git, no repo) returns
    None so the caller skips the reap (fail-closed when we cannot tell).
    """
    try:
        result = subprocess.run(
            ["git", "ls-files", "--error-unmatch", "--", str(path)],
            cwd=repo_root,
            capture_output=True,
            text=True,
        )
    except Exception:
        return None
    return result.returncode == 0


def _any_live_session(data_dir: Path, now: float) -> bool:
    """Return True if any touched-record file has been modified within the
    live-session window.

    Storage: ``.planctl/state/sessions/<sid>/touched/<uuid>.txt`` — one file
    per atomic_write. A fresh mtime on ANY such file (across all sessions)
    means a verb is actively mid-flight; we veto every reap until the
    window clears.

    Coarse-grained on purpose: naming-specific matching (the touched-log
    line names this orphan's epic JSON) would race the write that creates
    that very record, and the cost of waiting one more verb-cycle to reap
    is zero.
    """
    sessions_root = data_dir / "state" / "sessions"
    if not sessions_root.exists():
        return False
    cutoff = now - _LIVE_SESSION_WINDOW_SECONDS
    try:
        for session_dir in sessions_root.iterdir():
            touched_dir = session_dir / "touched"
            if not touched_dir.exists():
                continue
            for record in touched_dir.iterdir():
                try:
                    if record.stat().st_mtime >= cutoff:
                        return True
                except OSError:
                    continue
    except OSError:
        # Permission or transient filesystem error — fail closed (assume live).
        return True
    return False


def _collect_orphan_paths(epic_id: str, data_dir: Path) -> list[Path]:
    """Return every on-disk path belonging to *epic_id*.

    Mirrors ``run_epic_rm._collect_unlink_set`` — the unlink set is identical
    because what counts as "this epic's tree on disk" doesn't change
    between an interactive ``planctl epic rm`` and a reaper sweep. Kept
    inline rather than imported to keep the reaper a leaf module
    (no dependency on ``run_epic_rm`` so future moves stay mechanical).
    """
    state_dir = data_dir / "state"
    paths: list[Path] = []

    epic_json = data_dir / "epics" / f"{epic_id}.json"
    if epic_json.exists():
        paths.append(epic_json)

    specs_dir = data_dir / "specs"
    if specs_dir.exists():
        epic_spec = specs_dir / f"{epic_id}.md"
        if epic_spec.exists():
            paths.append(epic_spec)
        paths.extend(sorted(specs_dir.glob(f"{epic_id}.*.md")))

    tasks_dir = data_dir / "tasks"
    if tasks_dir.exists():
        paths.extend(sorted(tasks_dir.glob(f"{epic_id}.*.json")))

    state_tasks_dir = state_dir / "tasks"
    if state_tasks_dir.exists():
        paths.extend(sorted(state_tasks_dir.glob(f"{epic_id}.*.state.json")))

    state_locks_dir = state_dir / "locks"
    if state_locks_dir.exists():
        paths.extend(sorted(state_locks_dir.glob(f"{epic_id}.*.lock")))

    # Dedupe while preserving order.
    seen: set[Path] = set()
    unique: list[Path] = []
    for p in paths:
        if p in seen:
            continue
        seen.add(p)
        unique.append(p)
    return unique


def _reap_one(epic_id: str, data_dir: Path) -> int:
    """Record-touched + unlink every path under *epic_id*.

    Returns the count of paths unlinked. Mirrors the ``_record_touched``
    BEFORE ``unlink`` ordering from ``run_epic_rm`` so the reaper's
    deletions land in the touched-paths log of the verb whose pre-flight
    invoked it — the same verb's auto-commit then sweeps the deletions as
    part of its own ``.planctl/`` commit.

    Each unlink is wrapped in ``contextlib.suppress(FileNotFoundError)``
    because a concurrent reaper (two mutating verbs racing) may have
    already cleared the path.
    """
    from planctl.store import _record_touched

    unlinked = 0
    for p in _collect_orphan_paths(epic_id, data_dir):
        with contextlib.suppress(Exception):
            _record_touched(p, data_dir=data_dir)
        try:
            p.unlink()
            unlinked += 1
        except FileNotFoundError:
            # Concurrent reap; idempotent success.
            pass
        except OSError as exc:
            # Permission / disk error — log and continue with siblings; the
            # NEXT mutating verb's pre-flight gets another chance.
            _log_skip(f"unlink {p}: {exc}")
    return unlinked


def reap_orphan_epics(data_dir: Path, repo_root: Path) -> list[str]:
    """Sweep stale, unowned, untracked orphan epic trees under *data_dir*.

    Returns the list of epic_ids that were reaped (may be empty). NEVER
    raises — every failure path is logged-and-swallowed. Safe to invoke as
    a Phase-3 pre-flight from any mutating verb.

    Gate (BOTH must hold per orphan):

    1. ``.planctl/epics/<id>.json`` is git-untracked
       (``git ls-files --error-unmatch`` exits non-zero).
    2. The orphan JSON's mtime is older than ``_REAP_MIN_AGE_SECONDS``.
    3. No session has any touched-record modified within
       ``_LIVE_SESSION_WINDOW_SECONDS`` (host-wide veto).

    If ANY predicate fails (or we cannot determine it), the orphan stays
    on disk. The next mutating verb gets another chance.
    """
    try:
        epics_dir = data_dir / "epics"
        if not epics_dir.exists():
            return []

        # Host-wide live-session veto: if any session is actively writing,
        # don't reap ANYTHING this pass. Cheap O(sessions) scan, evaluated
        # once and reused across every orphan candidate.
        now = time.time()
        if _any_live_session(data_dir, now):
            return []

        reaped: list[str] = []
        for epic_json in sorted(epics_dir.glob("*.json")):
            stem = epic_json.stem
            if not _EPIC_ID_PATH_RE.match(stem):
                # Defensive: skip anything whose stem isn't a safe id. The
                # glob shouldn't produce these, but a stray file (e.g. a
                # tempfile from a crashed write) shouldn't crash the reaper.
                continue

            # Tracked-check: skip tracked files (they are authoritative).
            tracked = _is_tracked(epic_json, repo_root)
            if tracked is None:
                # Cannot determine — fail closed.
                continue
            if tracked:
                continue

            # Stale-check: skip recent untracked writes. A truly fresh
            # in-flight pre-commit tree (the fn-627 window) lives here.
            try:
                age = now - epic_json.stat().st_mtime
            except OSError:
                continue
            if age < _REAP_MIN_AGE_SECONDS:
                _log_skip(
                    f"{stem}: untracked but only {age:.0f}s old "
                    f"(min {_REAP_MIN_AGE_SECONDS}s) — likely in-flight"
                )
                continue

            # All gates passed — reap.
            count = _reap_one(stem, data_dir)
            if count > 0:
                reaped.append(stem)
                with contextlib.suppress(Exception):
                    print(
                        f"planctl.reaper: reaped orphan epic {stem} ({count} files)",
                        file=sys.stderr,
                    )
        return reaped
    except Exception as exc:
        # Fail-soft: a reaper error must NEVER block the actual mutation.
        with contextlib.suppress(Exception):
            print(f"planctl.reaper: error during sweep: {exc}", file=sys.stderr)
        return []


__all__ = (
    "reap_orphan_epics",
    "_REAP_MIN_AGE_SECONDS",
    "_LIVE_SESSION_WINDOW_SECONDS",
)
