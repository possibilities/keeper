"""planctl epic queue-jump - Flip the board-priority signal on an epic.

Primary contract: set queue_jump = True on the epic JSON, bump updated_at
(cohort-consistent with every other mutating verb), and ride queue_jump=True on
the planctl_invocation envelope so keeper folds the priority signal and projects
the `!`-prefixed sort_path that sorts the epic above all other root epics on the
board. This is the CLI contract the `/plan:next` skill consumes to push an
existing epic to the front of the queue.

Short-circuit: when queue_jump is already True, skip atomic_write_json and skip
the mutating commit. A readonly invocation envelope still lands so the audit row
and UDS event fire. Mirrors run_epic_invalidate.py's read-only short-circuit
shape in the opposite direction (set vs clear).

This verb is intentionally NOT in VALIDATION_RESTAMP_VERBS. queue_jump is a
board-priority signal, not structural plan content — the same stance as
invalidate, approve, and task-set-tier.
"""

from __future__ import annotations

from types import SimpleNamespace


def _render_human(data: dict) -> str:
    eid = data.get("epic_id")
    short_circuited = data.get("short_circuited", False)
    if short_circuited:
        return f"{eid}: queue_jump already true, no write"
    return f"{eid}: queue_jump set true (was false)"


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

    # Short-circuit: priority already set → readonly envelope only, no write.
    if epic_def.get("queue_jump") is True:
        pc = build_planctl_invocation_readonly(
            "queue-jump",
            epic_id,
            repo_root=ctx.project_path,
        )
        emit(
            {"epic_id": epic_id, "short_circuited": True},
            text_renderer=_render_human,
            planctl_invocation=pc,
        )
        return 0

    # False → True transition: write the flag and route through the central
    # seam. Rewrite of a pre-existing tracked file (atomic_write rename-atomic)
    # → no unwind. emit() builds the invocation with queue_jump=True so keeper
    # folds the priority signal off this envelope.
    epic_def["queue_jump"] = True
    epic_def["updated_at"] = now_iso()
    atomic_write_json(epic_path, epic_def)

    emit(
        {"epic_id": epic_id, "short_circuited": False},
        text_renderer=_render_human,
        verb="queue-jump",
        target=epic_id,
        repo_root=ctx.project_path,
        primary_repo=primary_repo,
        queue_jump=True,
    )
    return 0
