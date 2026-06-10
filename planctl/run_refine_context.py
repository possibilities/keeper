"""planctl refine-context - refine-state fetch for /plan:plan Phase R2.

Read-only by default; **conditionally mutating** when ``--invalidate`` is
passed (clears ``last_validated_at`` on the epic in the same call that
returns the envelope — collapses Phase R1's ``epic invalidate`` + Phase R2's
``refine-context`` into one round trip).  Mirrors ``validate --epic``'s
conditionally-mutating precedent: the runner manually emits the envelope and
invokes ``auto_commit_from_invocation`` so exactly one envelope + one commit
lands when the flag is set.  Without the flag, behavior is unchanged.

Collapses the /plan:plan Phase R2 hand-fired sequence (``show`` for epic
metadata, ``cat <epic>`` for the epic spec markdown, ``tasks --epic`` for the
child task list, and per-task ``cat <task_id>`` for each existing task spec)
into a single verb that returns one envelope:

    {
      "epic_id": <epic_id>,
      "title": <str | null>,
      "branch": <str | null>,          # epic.branch_name
      "last_validated_at": <iso | null>,
      "epic_spec_md": <str>,           # raw markdown ("" when spec absent)
      "tasks": [
        {"id", "title", "status", "deps", "snippets", "bundles", "spec_md"},
        ...
      ],
    }

``tasks`` is ``[]`` for an empty epic. Both the epic route and the task route
of the refine path consume this verb: the task route also needs the parent
epic spec (``epic_spec_md``), which this envelope already carries, so the
caller derives ``epic_id`` by stripping the ``.M`` suffix and fires the same
verb.

Resolution is cwd-based via ``resolve_project`` — matching today's cwd-bound
refine reads (``show`` / ``cat`` / ``tasks`` all resolve the project from cwd).

Without ``--invalidate`` this is a **read-only** verb: it mutates nothing and
rides the ``InvocationTrackedGroup`` auto-readonly invocation line (NOT in
``_NO_TRACK_COMMANDS``), same as ``detect`` / ``status`` / ``close-preflight``.
On the error path it sets the invocation sentinel so the decorator does not
double-emit after the terminal error envelope. Uses claim's single-fetch
error shape (``{success:false, error:{code, message, details}}``).

With ``--invalidate`` and the marker already null, the runner short-circuits
the write but still emits via the readonly invocation builder; with the marker
stamped, the runner writes ``last_validated_at = None`` + bumps ``updated_at``,
emits via the mutating invocation builder, and rides ``output.emit``'s
auto-commit so one ``chore(planctl): refine-context <epic>`` commit lands.

Error codes: ``BAD_EPIC_ID`` / ``EPIC_NOT_FOUND``.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any


def _emit_refine_error(
    code: str, message: str, *, details: dict[str, Any] | None = None
) -> None:
    """Emit a typed refine-context error envelope and exit 1.

    Shape: ``{"success": false, "error": {"code", "message", "details"}}``
    (claim's single-fetch error shape). Routes through ``format_output`` so
    ``--format yaml`` renders YAML. No ``planctl_invocation`` is emitted — a
    failed read-only fetch mutates nothing. The sentinel guards the
    ``InvocationTrackedGroup`` decorator against double-emitting a trailing
    read-only envelope after this terminal error. Mirrors
    ``run_close_preflight._emit_preflight_error``.
    """
    from planctl._util import format_output  # vendored — see _util.py

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


def _read_spec_md(data_dir: Path, spec_id: str) -> str:
    """Read the raw spec markdown for an epic/task id (mirrors run_cat / run_claim).

    Missing spec → empty string (the refine fetch tolerates a spec-less entity;
    existence of the epic/task is gated upstream for the epic, and per-task
    specs may legitimately be absent on a freshly-created task).
    """
    spec_path = data_dir / "specs" / f"{spec_id}.md"
    if not spec_path.exists():
        return ""
    return spec_path.read_text(encoding="utf-8")


def run(args: SimpleNamespace) -> int:
    from planctl.api import load_epic, load_tasks_for_epic, task_sort_key
    from planctl.ids import is_epic_id
    from planctl.output import emit
    from planctl.project import resolve_project

    epic_id: str = args.epic_id
    invalidate: bool = bool(getattr(args, "invalidate", False))

    if not is_epic_id(epic_id):
        _emit_refine_error("BAD_EPIC_ID", f"Invalid epic ID: {epic_id}")

    ctx = resolve_project()
    data_dir = ctx.data_dir

    epic_path = data_dir / "epics" / f"{epic_id}.json"
    if not epic_path.exists():
        _emit_refine_error(
            "EPIC_NOT_FOUND",
            f"Epic not found in {ctx.project_path}: {epic_id}",
        )

    epic_def = load_epic(ctx, epic_id)
    epic_spec_md = _read_spec_md(data_dir, epic_id)

    # Tasks, sorted by ordinal, with runtime state merged in. Each entry
    # carries the per-task spec markdown so the caller never re-fires `cat`.
    merged_tasks = sorted(
        load_tasks_for_epic(ctx, epic_id),
        key=lambda t: task_sort_key(t.get("id", "")),
    )
    tasks = [
        {
            "id": t.get("id"),
            "title": t.get("title"),
            "status": t.get("status", "todo"),
            "deps": t.get("depends_on", []),
            "snippets": t.get("snippets", []),
            "bundles": t.get("bundles", []),
            "spec_md": _read_spec_md(data_dir, t.get("id", "")),
        }
        for t in merged_tasks
    ]

    # Conditionally-mutating ``--invalidate`` path.
    # Mirrors ``validate --epic``'s precedent — when the flag asks us to
    # mutate, write first, then emit via ``output.emit`` so a single envelope
    # + single auto-commit lands.  Without the flag (the common case) the
    # path stays purely read-only and the InvocationTrackedGroup decorator
    # emits the trailing readonly invocation line as usual.
    if invalidate:
        from planctl.invocation import build_planctl_invocation_readonly
        from planctl.store import atomic_write_json, load_json, now_iso

        if epic_def.get("last_validated_at") is None:
            # Short-circuit: marker already null → readonly envelope, no write.
            # Mirrors ``run_epic_invalidate``'s short-circuit branch.
            pc = build_planctl_invocation_readonly(
                "refine-context",
                epic_id,
                repo_root=ctx.project_path,
            )
            emit(
                {
                    "epic_id": epic_id,
                    "title": epic_def.get("title"),
                    "branch": epic_def.get("branch_name"),
                    "last_validated_at": None,
                    "epic_spec_md": epic_spec_md,
                    "tasks": tasks,
                    "invalidated": False,
                },
                planctl_invocation=pc,
            )
            return 0

        # Stamped → None transition.  Load the raw epic JSON (not the
        # normalized dict above) so atomic_write_json round-trips the same
        # fields the rest of the surface persists.
        raw_epic = load_json(epic_path)
        raw_epic["last_validated_at"] = None
        raw_epic["updated_at"] = now_iso()
        atomic_write_json(epic_path, raw_epic)

        # Route through the central seam at output.emit().
        # Rewrite of a pre-existing tracked file (atomic_write rename-atomic)
        # → no unwind. The previous direct ``build_planctl_invocation`` call
        # lived outside the seam's try-block, so a missing CLAUDE_CODE_SESSION_ID
        # raise from the build would have surfaced AFTER the write landed
        # without the structured ``commit_failed`` envelope contract.
        emit(
            {
                "epic_id": epic_id,
                "title": epic_def.get("title"),
                "branch": epic_def.get("branch_name"),
                "last_validated_at": None,
                "epic_spec_md": epic_spec_md,
                "tasks": tasks,
                "invalidated": True,
            },
            verb="refine-context",
            target=epic_id,
            repo_root=ctx.project_path,
            primary_repo=raw_epic.get("primary_repo"),
        )
        return 0

    emit(
        {
            "epic_id": epic_id,
            "title": epic_def.get("title"),
            "branch": epic_def.get("branch_name"),
            "last_validated_at": epic_def.get("last_validated_at"),
            "epic_spec_md": epic_spec_md,
            "tasks": tasks,
        }
    )
    return 0
