"""planctl epic ack - Acknowledge a closer drain so the gate clears (fn-386).

Stamps the ack timestamp in the gitignored SQLite at
``<repo>/.planctl/state/acks.db`` (fn-488).  The tracked epic JSON is
NOT mutated; the plug-side bundle builder merges the ack value back
into the broadcast bundle so existing observers
(``_maybe_auto_audit_on_epic_close``, ``_maybe_auto_disarm_on_epic_ack``,
planctl watch, plus other board readers) continue to read it from the
same dict shape they always have.

Idempotent on re-call (UPSERT overwrites the timestamp).  Fails-
visibly on unknown epic / wrong id type.  NOT in
``VALIDATION_RESTAMP_VERBS`` — ack is runtime, not structural.

Stale ack (``closer_done_at`` is None) is intentional; the
``acked_at < done_at`` predicate re-arms the gate on the next done
stamp.

fn-488 — see ``run_task_ack.py`` for the full rationale.  The
``primary_repo`` argument is still threaded through
``build_planctl_invocation`` so the audit row (still committed by the
hook on the rare CLI-driven ack from a non-plug context) routes to
the right multi-repo target.
"""

from __future__ import annotations

from types import SimpleNamespace


def run(args: SimpleNamespace) -> int:
    from planctl import acks
    from planctl.ids import is_epic_id
    from planctl.invocation import build_planctl_invocation
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.store import load_json, now_iso

    epic_id: str = args.epic_id

    if not is_epic_id(epic_id):
        emit_error(f"Invalid epic ID: {epic_id}")

    ctx = resolve_project()
    data_dir = ctx.data_dir

    # Existence + primary_repo lookup still runs against the tracked
    # JSON — the acks database is keyed by epic id alone and has no
    # notion of "is this a real epic?".  A typo'd id would otherwise
    # silently insert a phantom row.
    epic_path = data_dir / "epics" / f"{epic_id}.json"
    if not epic_path.exists():
        emit_error(f"Epic not found: {epic_id}")

    epic_def = load_json(epic_path)

    now = now_iso()
    acks.save_epic_ack(epic_id, now, repo_root=ctx.project_path)

    pc = build_planctl_invocation(
        "epic-ack",
        epic_id,
        repo_root=ctx.project_path,
        primary_repo=epic_def.get("primary_repo"),
    )

    emit(
        {
            "epic_id": epic_id,
            "closer_acked_at": now,
        },
        planctl_invocation=pc,
    )
    return 0
