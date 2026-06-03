"""planctl epic followup-of - find a single follow-up epic for /plan:close.

Read-only fetch. Scans open epics for one whose ``depends_on_epics`` contains
the source epic id and returns a single-shot envelope so /plan:close can drop
its Phase 7 hand-fired ``epics --status open`` + per-row JSON walk to discover
the follow-up.

Returned envelope shape (success, exit 0):

    Found:    {"success": true,
               "found": true,
               "epic_id": "<follow-up epic id>",
               "actual_tasks": <int>,
               "depends_on_epics": [<source>, ...],
               "status": "<open|closed|done>"}
    Absent:   {"success": true, "found": false}

The verb does NOT compute "completeness" — the caller compares
``actual_tasks`` against its in-memory expected count.  ``actual_tasks`` is
the count of task JSONs on disk for the follow-up epic; ``depends_on_epics``
is the raw list off the follow-up epic JSON.

Multiple-match behavior: ``/plan:close`` Phase 7 expects exactly one follow-up
epic per source.  When multiple open epics declare the source as a dep, the
verb returns the first one in alphabetic (sorted) order — deterministic
across filesystems — and surfaces nothing else; the caller can re-run the
discovery if needed.
A future refine can extend the envelope with a ``candidates`` list, but the
single-shot shape matches today's skill expectation.

This is a **read-only** verb: it mutates nothing and rides the
``InvocationTrackedGroup`` auto-readonly invocation line (NOT in
``_NO_TRACK_COMMANDS``), same as ``detect`` / ``status`` / ``close-preflight``.
On the error path it sets the invocation sentinel so the decorator does not
double-emit after the terminal error envelope. Uses claim's single-fetch
error shape (``{success:false, error:{code, message, details}}``).
Error codes: ``BAD_EPIC_ID``.  A missing source epic is NOT an error — the
verb still returns ``{found: false}`` because no follow-up can wire to a dep
that doesn't exist on disk, so the answer to "is there a follow-up?" is no.
"""

from __future__ import annotations

import sys
from types import SimpleNamespace
from typing import Any


def _emit_followup_error(
    code: str, message: str, *, details: dict[str, Any] | None = None
) -> None:
    """Emit a typed followup-of error envelope and exit 1.

    Shape: ``{"success": false, "error": {"code", "message", "details"}}``
    (claim's single-fetch error shape). Routes through ``format_output`` so
    ``--format yaml`` renders YAML. No ``planctl_invocation`` is emitted — a
    failed read-only fetch mutates nothing. The sentinel guards the
    ``InvocationTrackedGroup`` decorator against double-emitting a trailing
    read-only envelope after this terminal error. Mirrors
    ``run_close_preflight._emit_preflight_error``.
    """
    from planctl._util import format_output

    error: dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        error["details"] = details
    format_output({"success": False, "error": error})
    _set_invocation_sentinel()
    sys.exit(1)


def _set_invocation_sentinel() -> None:
    """Set INVOCATION_EMITTED_SENTINEL on the active click context.

    Guards ``InvocationTrackedGroup.invoke`` against emitting a trailing
    read-only ``planctl_invocation`` line after our error path already wrote a
    terminal envelope. No-op when there is no active click context (tests
    calling ``run()`` directly). Mirrors
    ``run_close_preflight._set_invocation_sentinel``.
    """
    try:
        import click

        from planctl.output import INVOCATION_EMITTED_SENTINEL

        cctx = click.get_current_context()
        if cctx.obj is None:
            cctx.obj = {}
        if isinstance(cctx.obj, dict):
            cctx.obj[INVOCATION_EMITTED_SENTINEL] = True
    except RuntimeError:
        pass


def run(args: SimpleNamespace) -> int:
    from planctl.ids import is_epic_id
    from planctl.output import emit
    from planctl.project import resolve_project
    from planctl.store import load_json_safe

    source_epic_id: str = args.source_epic_id

    if not is_epic_id(source_epic_id):
        _emit_followup_error("BAD_EPIC_ID", f"Invalid epic ID: {source_epic_id}")

    ctx = resolve_project()
    data_dir = ctx.data_dir
    epics_dir = data_dir / "epics"
    tasks_dir = data_dir / "tasks"

    # Empty .planctl tree (no epics directory yet) → no follow-up possible.
    # Mirrors the way close-preflight tolerates missing directories.
    if not epics_dir.exists():
        emit({"found": False})
        return 0

    # First-seen wins.  ``sorted(glob())`` gives alphabetic order on filename,
    # which is deterministic across filesystems — the same project always
    # yields the same answer regardless of inode layout.  Skip the source
    # epic itself (an epic that lists itself in depends_on_epics is a
    # structural error caught upstream, but we still filter defensively).
    for ep_file in sorted(epics_dir.glob("*.json")):
        if ep_file.stem == source_epic_id:
            continue
        ep_def = load_json_safe(ep_file)
        if ep_def is None:
            continue
        if ep_def.get("status") != "open":
            continue
        depends_on_epics = list(ep_def.get("depends_on_epics", []))
        if source_epic_id not in depends_on_epics:
            continue

        candidate_id = ep_def.get("id", ep_file.stem)
        actual_tasks = 0
        if tasks_dir.exists():
            actual_tasks = sum(1 for _ in tasks_dir.glob(f"{candidate_id}.*.json"))

        emit(
            {
                "found": True,
                "epic_id": candidate_id,
                "actual_tasks": actual_tasks,
                "depends_on_epics": depends_on_epics,
                "status": ep_def.get("status"),
            }
        )
        return 0

    emit({"found": False})
    return 0
