"""planctl epic invalidate - Clear the validation marker on an epic.

Primary contract: set last_validated_at = None on the epic JSON and bump
updated_at (cohort-consistent with every other mutating verb). Enables eager
invalidation at the start of a refine pass so the epic is marked dirty before
any structural mutations land.

Short-circuit: when last_validated_at is already None, skip atomic_write_json
and skip the mutating commit. A readonly invocation envelope still lands so the
audit row and UDS event fire. Mirrors run_validate.py's "no-op re-validate is
fully read-only" precedent in the opposite direction.

This verb is intentionally NOT in VALIDATION_RESTAMP_VERBS. That tuple's job is
rot-prevention for verbs that clear the marker as a side effect of structural
mutation. invalidate's primary job IS the clear — it gets dedicated tests
instead of a slot in the tuple.
"""

from __future__ import annotations

from types import SimpleNamespace


def _render_human(data: dict) -> str:
    eid = data.get("epic_id")
    short_circuited = data.get("short_circuited", False)
    if short_circuited:
        return f"{eid}: last_validated_at already null, no write"
    return f"{eid}: last_validated_at cleared (was stamped)"


def run(args: SimpleNamespace) -> int:
    from planctl.invocation import build_planctl_invocation_readonly
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.store import atomic_write_json, load_json, now_iso

    epic_id: str = args.epic_id

    ctx = resolve_project()
    data_dir = ctx.data_dir

    epic_path = data_dir / "epics" / f"{epic_id}.json"
    if not epic_path.exists():
        emit_error(f"Epic not found: {epic_id}")

    epic_def = load_json(epic_path)
    primary_repo: str | None = epic_def.get("primary_repo")

    # Short-circuit: marker already null → readonly envelope only, no write.
    if epic_def.get("last_validated_at") is None:
        pc = build_planctl_invocation_readonly(
            "invalidate",
            epic_id,
            repo_root=ctx.project_path,
        )
        emit(
            {"epic_id": epic_id, "short_circuited": True},
            text_renderer=_render_human,
            planctl_invocation=pc,
        )
        return 0

    # Stamp → None transition: write marker and route through the central seam.
    # Rewrite of a pre-existing tracked file (atomic_write rename-atomic) → no
    # unwind (fn-629 task .3).
    epic_def["last_validated_at"] = None
    epic_def["updated_at"] = now_iso()
    atomic_write_json(epic_path, epic_def)

    emit(
        {"epic_id": epic_id, "short_circuited": False},
        text_renderer=_render_human,
        verb="invalidate",
        target=epic_id,
        repo_root=ctx.project_path,
        primary_repo=primary_repo,
        written_paths=[],
    )
    return 0
