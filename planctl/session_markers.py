"""Per-session marker files — the cross-language guard contract.

One JSON file per Claude session at
``~/.local/state/planctl/sessions/<session_id>.json``, schema_version 1:

    {schema_version, session_id, kind: "work"|"close",
     task_id (work) | epic_id (close), created_at}

The TS hook dispatchers (PreToolUse commit deny, SubagentStop worker guard,
Stop checklist guard) read these files to decide whether a main-context agent
is mid-task. Field names and ``kind`` values are a cross-language contract:
deviating from this schema breaks the dispatchers silently.

**Fail open.** The session id comes from ``CLAUDE_CODE_SESSION_ID`` read here
directly — absent env var makes every helper a silent no-op (manual and test
invocations must not error or write). All filesystem errors are swallowed:
marker IO never fails the verb that calls it. A write on a verb's error path
would create a guard lockout for a task that was never claimed, so callers
invoke these strictly on their success path.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

SCHEMA_VERSION = 1

#: Markers older than this are unlinked when a reader touches them.
_STALE_AFTER_SECONDS = 7 * 24 * 60 * 60


def _session_id() -> str | None:
    """Resolve the session id from the env, fail-open.

    Distinct from ``invocation._build``'s fail-CLOSED resolution: an absent
    env var here returns ``None`` (caller no-ops) rather than raising.
    """
    return os.environ.get("CLAUDE_CODE_SESSION_ID") or None


def _sessions_dir() -> Path:
    """The session-marker directory (``~/.local/state/planctl/sessions``).

    Resolved at call time so a monkeypatched ``HOME`` (tests) is honored.
    Mirrors ``run_epic_create``'s ``~/.local/state/planctl/`` precedent.
    """
    return Path("~/.local/state/planctl/sessions").expanduser()


def _marker_path(session_id: str) -> Path:
    return _sessions_dir() / f"{session_id}.json"


def _write_marker(kind: str, id_field: str, target_id: str) -> None:
    """Write the marker for the current session. Silent no-op when no session
    id; all filesystem errors swallowed."""
    session_id = _session_id()
    if session_id is None:
        return
    record = {
        "schema_version": SCHEMA_VERSION,
        "session_id": session_id,
        "kind": kind,
        id_field: target_id,
        "created_at": _now_iso(),
    }
    try:
        path = _marker_path(session_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record), encoding="utf-8")
    except OSError:
        # Marker IO must never fail the verb.
        return


def _clear_if_matches(id_field: str, target_id: str) -> None:
    """Unlink the current session's marker only when its ``id_field`` matches
    ``target_id``. A mismatched marker is left intact; all errors swallowed."""
    session_id = _session_id()
    if session_id is None:
        return
    try:
        path = _marker_path(session_id)
        raw = path.read_text(encoding="utf-8")
        record = json.loads(raw)
    except (OSError, ValueError):
        return
    if not isinstance(record, dict):
        return
    if record.get(id_field) != target_id:
        return
    try:
        path.unlink()
    except OSError:
        return


def _now_iso() -> str:
    """Local ``now_iso`` so importing this module never pulls in the store."""
    from planctl.store import now_iso

    return now_iso()


def write_work_marker(task_id: str) -> None:
    """Mark this session as actively working ``task_id`` (``kind="work"``).

    Called on the success path of ``claim`` and ``worker resume``.
    """
    _write_marker("work", "task_id", task_id)


def write_close_marker(epic_id: str) -> None:
    """Mark this session as closing ``epic_id`` (``kind="close"``).

    Called on the success path of ``close-preflight``.
    """
    _write_marker("close", "epic_id", epic_id)


def clear_work_marker(task_id: str) -> None:
    """Clear the work marker, but only if it names ``task_id``.

    Called by ``done`` and ``block``: a session whose marker names a different
    task must not have it cleared by a sibling verb.
    """
    _clear_if_matches("task_id", task_id)


def clear_close_marker(epic_id: str) -> None:
    """Clear the close marker, but only if it names ``epic_id``.

    Called by ``close-finalize`` on every terminal outcome.
    """
    _clear_if_matches("epic_id", epic_id)


def read_marker(session_id: str) -> dict | None:
    """Return the parsed marker for ``session_id``, or ``None``.

    Unlinks-and-returns-``None`` for a marker older than 7 days (stale-on-read)
    and for an unparseable / non-dict file. All filesystem errors are swallowed.
    Provided for the guard dispatchers' Python-side tests and any in-process
    reader; the TS dispatchers read the same files independently.
    """
    try:
        path = _marker_path(session_id)
        if not path.exists():
            return None
        if (time.time() - path.stat().st_mtime) > _STALE_AFTER_SECONDS:
            try:
                path.unlink()
            except OSError:
                pass
            return None
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(record, dict):
        try:
            _marker_path(session_id).unlink()
        except OSError:
            pass
        return None
    return record
