"""planctl task ack - Acknowledge a worker drain so the gate clears (fn-386).

Stamps the ack timestamp in the gitignored SQLite at
``<repo>/.planctl/state/acks.db`` (fn-488).  The tracked task JSON is
NOT mutated; downstream observers merge the ack value back into the
broadcast bundle so they continue to read it from the same dict
shape they always have.

Idempotent on re-call (UPSERT overwrites the timestamp).  Fails-
visibly on unknown task / wrong id type.  NOT in
``VALIDATION_RESTAMP_VERBS`` — ack is runtime, not structural.

Stale ack (``worker_done_at`` is None) is intentional; the
``acked_at < done_at`` predicate re-arms the gate on the next done
stamp.

fn-488 — pre-fn-488 the ack landed on the tracked task JSON and the
hookctl ``planctl-mutation`` post-hook committed the .planctl/ tree
on every CLI invocation.  External-process-fired acks bypass the
Bash hook and created a long tail of orphaned acks needing rescue
commits; moving the stamp to gitignored state eliminates that class
of problem.  The ``files=[]`` envelope below reflects the new
contract: ack writes mutate runtime state only, never tracked files.
"""

from __future__ import annotations

from types import SimpleNamespace


def run(args: SimpleNamespace) -> int:
    from planctl import acks
    from planctl.ids import is_task_id
    from planctl.invocation import build_planctl_invocation
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.store import now_iso

    task_id: str = args.task_id

    if not is_task_id(task_id):
        emit_error(f"Invalid task ID: {task_id}")

    ctx = resolve_project()
    data_dir = ctx.data_dir

    # Existence check still runs against the tracked JSON — the acks
    # database is keyed by task id alone and has no notion of "is this
    # a real task?", so a typo'd id would silently insert a phantom
    # row.  Catch it here against the canonical source of truth.
    task_path = data_dir / "tasks" / f"{task_id}.json"
    if not task_path.exists():
        emit_error(f"Task not found: {task_id}")

    now = now_iso()
    acks.save_task_ack(task_id, now, repo_root=ctx.project_path)

    pc = build_planctl_invocation("task-ack", task_id, repo_root=ctx.project_path)

    emit(
        {
            "task_id": task_id,
            "worker_acked_at": now,
        },
        planctl_invocation=pc,
    )
    return 0
