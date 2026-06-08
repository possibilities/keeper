"""Atomic file operations, state store, and utility functions."""

from __future__ import annotations

import json
import os
import sys
import uuid
from contextlib import contextmanager
from datetime import UTC
from pathlib import Path

from planctl._util import atomic_write as _atomic_write_raw


def _record_touched(path: Path, data_dir: Path | None = None) -> None:
    """Append *path* to the current session's touched-paths log.

    Storage: ``.planctl/state/sessions/<sid>/touched/<uuid>.txt`` — one file
    per write so concurrent workers never contend (lock-free).

    ``data_dir`` defaults to ``path.parent`` walked up to find ``.planctl/``
    when not provided explicitly. If session id cannot be resolved (outside
    Claude harness), this call is silently skipped — the failure mode is a
    fallback to wildcard staging at commit time, which the hookctl
    planctl-mutation post-hook will reject with a ``RuntimeError``.
    """
    try:
        import os as _os

        # CLAUDE_CODE_SESSION_ID env var is the sole source of the session id —
        # the claude binary ships it intrinsically on every session, or this
        # call silently skips and the verb falls back to wildcard staging at
        # commit time (rejected by the planctl auto-commit step). Tests and
        # manual invocations also set this directly.
        sid = _os.environ.get("CLAUDE_CODE_SESSION_ID") or None
        if not sid:
            return

        # Resolve data_dir: walk up from path to find .planctl/ directory.
        if data_dir is None:
            check = path.resolve().parent
            for _ in range(20):
                candidate = check / ".planctl"
                if candidate.is_dir():
                    data_dir = candidate
                    break
                parent = check.parent
                if parent == check:
                    return  # no .planctl/ found
                check = parent
            if data_dir is None:
                return

        touched_dir = data_dir / "state" / "sessions" / sid / "touched"
        touched_dir.mkdir(parents=True, exist_ok=True)

        # Normalize the path relative to data_dir's parent (the repo root).
        repo_root = data_dir.parent
        try:
            rel = path.resolve().relative_to(repo_root.resolve())
            rel_str = rel.as_posix()
        except ValueError:
            # Path outside repo root — skip silently.
            return

        touch_file = touched_dir / f"{uuid.uuid4().hex}.txt"
        touch_file.write_text(rel_str + "\n", encoding="utf-8")
    except Exception:
        # Never let recorder failures surface to callers.
        pass


def _read_touched_files(data_dir: Path, session_id: str) -> list[str]:
    """Return the list of touched-path record files for *session_id*.

    Each entry is a POSIX path string for a
    ``.planctl/state/sessions/<sid>/touched/<uuid>.txt`` file — the actual
    record file, not its content.  The hook uses this list to clean up after
    a successful commit (gap-analyst G7).

    Returns an empty list when the touched dir doesn't exist yet.
    """
    touched_dir = data_dir / "state" / "sessions" / session_id / "touched"
    if not touched_dir.exists():
        return []
    # Return POSIX paths relative to data_dir's parent (repo root).
    repo_root = data_dir.parent
    result: list[str] = []
    for txt in touched_dir.glob("*.txt"):
        try:
            rel = txt.resolve().relative_to(repo_root.resolve())
            result.append(rel.as_posix())
        except ValueError:
            pass
    return sorted(result)


def atomic_write(path: Path, content: str, data_dir: Path | None = None) -> None:
    """Write *path* atomically, then record it in the session touched-paths log.

    Drop-in replacement for ``planctl._util.atomic_write`` within planctl.
    Records the write in the session touched-paths log on top of the
    atomic-write primitive.

    ``data_dir`` is the ``.planctl/`` directory (passed explicitly by callers
    that already have it; auto-detected from *path* otherwise).
    """
    _atomic_write_raw(path, content)
    _record_touched(path, data_dir=data_dir)


def atomic_write_json(path: Path, data: dict, data_dir: Path | None = None) -> None:
    """Write JSON file atomically with sorted keys."""
    content = json.dumps(data, indent=2, sort_keys=True) + "\n"
    atomic_write(path, content, data_dir=data_dir)


def load_json(path: Path) -> dict:
    """Load JSON file. Raises on missing/invalid."""
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_json_safe(path: Path) -> dict | None:
    """Returns None if missing or corrupt."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, FileNotFoundError, json.JSONDecodeError):
        return None


def read_file_or_stdin(file_arg: str | None) -> str:
    """Read from file path or stdin."""
    if file_arg is None or file_arg == "-":
        return sys.stdin.read()
    return Path(file_arg).read_text(encoding="utf-8")


class LocalFileStateStore:
    """File-based state store with fcntl locking.

    Holds two families of gitignored runtime sidecars under
    ``.planctl/state/``:

    * ``tasks/<task_id>.state.json`` — per-task runtime state (status,
      assignee, evidence, …) AND the task's ``approval`` gate value (fn-732).
      Approval shares the task file rather than a third file so a single
      ``lock_task`` RMW serializes a concurrent ``status`` write against an
      approval write.
    * ``epics/<epic_id>.state.json`` — per-epic runtime sidecar; today it
      carries only the epic's ``approval`` value (fn-732). Epics have no
      ``status``/assignee runtime overlay, so the sidecar is approval-only.

    All reads are read-never-creates: an absent sidecar returns ``None`` /
    "no approval recorded", never a freshly-written empty file. This keeps the
    cold-start hot path side-effect free (mirrors ``acks.py``'s
    ``_open_for_read`` discipline).
    """

    def __init__(self, state_dir: Path):
        self.state_dir = state_dir
        self.tasks_dir = state_dir / "tasks"
        self.epics_dir = state_dir / "epics"
        self.locks_dir = state_dir / "locks"

    def _state_path(self, task_id: str) -> Path:
        return self.tasks_dir / f"{task_id}.state.json"

    def _epic_state_path(self, epic_id: str) -> Path:
        return self.epics_dir / f"{epic_id}.state.json"

    def _lock_path(self, task_id: str) -> Path:
        return self.locks_dir / f"{task_id}.lock"

    def load_runtime(self, task_id: str) -> dict | None:
        """Load runtime state for a task."""
        state_path = self._state_path(task_id)
        if not state_path.exists():
            return None
        try:
            with open(state_path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            return None

    def save_runtime(self, task_id: str, data: dict) -> None:
        """Save runtime state for a task."""
        self.tasks_dir.mkdir(parents=True, exist_ok=True)
        state_path = self._state_path(task_id)
        content = json.dumps(data, indent=2, sort_keys=True) + "\n"
        atomic_write(state_path, content)

    def read_task_approval(self, task_id: str) -> str | None:
        """Return the task's sidecar ``approval`` value, or ``None`` if absent.

        Read-never-creates: a missing sidecar, a sidecar with no ``approval``
        key, or a corrupt file all return ``None`` so the caller's resolution
        ladder falls through to the committed def. No lock is taken — a torn
        read of the JSON surfaces as ``None`` (the ladder degrades to def),
        never a raise.
        """
        runtime = self.load_runtime(task_id)
        if runtime is None:
            return None
        return runtime.get("approval")

    def write_task_approval(self, task_id: str, approval: str) -> None:
        """Set the task's sidecar ``approval`` value under ``lock_task`` RMW.

        Read-modify-write inside the per-task lock so a concurrent ``status``
        write (``done`` / ``claim`` / ``block``) is never clobbered — the
        approval write only touches the ``approval`` key and re-serializes the
        whole runtime dict. An absent sidecar is seeded as an approval-only
        ``{"approval": ...}`` dict; the next ``status`` write fills in the rest.
        """
        with self.lock_task(task_id):
            runtime = self.load_runtime(task_id) or {}
            runtime["approval"] = approval
            self.save_runtime(task_id, runtime)

    def load_epic_runtime(self, epic_id: str) -> dict | None:
        """Load the epic runtime sidecar, or ``None`` if absent/corrupt."""
        state_path = self._epic_state_path(epic_id)
        if not state_path.exists():
            return None
        try:
            with open(state_path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            return None

    def save_epic_runtime(self, epic_id: str, data: dict) -> None:
        """Save the epic runtime sidecar."""
        self.epics_dir.mkdir(parents=True, exist_ok=True)
        state_path = self._epic_state_path(epic_id)
        content = json.dumps(data, indent=2, sort_keys=True) + "\n"
        atomic_write(state_path, content)

    def read_epic_approval(self, epic_id: str) -> str | None:
        """Return the epic's sidecar ``approval`` value, or ``None`` if absent.

        Read-never-creates, mirroring :meth:`read_task_approval`.
        """
        runtime = self.load_epic_runtime(epic_id)
        if runtime is None:
            return None
        return runtime.get("approval")

    def write_epic_approval(self, epic_id: str, approval: str) -> None:
        """Set the epic's sidecar ``approval`` value under ``lock_task`` RMW.

        Epics have no concurrent ``status`` writer the way tasks do, but the
        RMW-under-lock shape is kept symmetric with the task path so a future
        epic-runtime field cannot be clobbered. The lock namespace reuses
        ``_lock_path(epic_id)`` (epic ids and task ids never collide).
        """
        with self.lock_task(epic_id):
            runtime = self.load_epic_runtime(epic_id) or {}
            runtime["approval"] = approval
            self.save_epic_runtime(epic_id, runtime)

    @contextmanager
    def lock_task(self, task_id: str):
        """Acquire exclusive lock for task operations."""
        import fcntl

        self.locks_dir.mkdir(parents=True, exist_ok=True)
        lock_path = self._lock_path(task_id)
        with open(lock_path, "w") as f:
            try:
                fcntl.flock(f, fcntl.LOCK_EX)
                yield
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)

    def list_runtime_files(self) -> list[str]:
        """List task IDs that have runtime state files."""
        if not self.tasks_dir.exists():
            return []
        return [
            f.stem.replace(".state", "") for f in self.tasks_dir.glob("*.state.json")
        ]


def get_actor() -> str:
    """Determine current actor identity."""
    import subprocess

    if actor := os.environ.get("PLANCTL_ACTOR"):
        return actor.strip()

    try:
        result = subprocess.run(
            ["git", "config", "user.email"],
            capture_output=True,
            text=True,
            check=True,
        )
        if email := result.stdout.strip():
            return email
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass

    try:
        result = subprocess.run(
            ["git", "config", "user.name"],
            capture_output=True,
            text=True,
            check=True,
        )
        if name := result.stdout.strip():
            return name
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass

    return os.environ.get("USER", "unknown")


def now_iso() -> str:
    """Current UTC timestamp in ISO 8601 format with microsecond precision.

    fn-587 task .1: upgraded from second-precision (``%Y-%m-%dT%H:%M:%SZ``)
    to microsecond-precision (``%Y-%m-%dT%H:%M:%S.%fZ``). The microsecond
    upgrade was originally load-bearing for a keeper-side stamp-disarm check
    (since deleted with the rest of that surface, fn-604); the precision is
    retained so external observers can disambiguate structural verbs that
    re-stamp ``last_validated_at`` within the same wall-clock second.

    Lexicographic sort still works (microseconds widen the time field, they
    don't change ordering); ``datetime.fromisoformat`` parses both the new
    and legacy shapes without changes.
    """
    from datetime import datetime

    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
