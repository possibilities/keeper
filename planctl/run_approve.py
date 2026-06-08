"""planctl approve — set the approval gate on an epic or task (fn-592).

Top-level verb (not in epic/task subgroup) because it covers both surfaces
with a single positional argument:

    planctl approve <epic_id> <status>                # epic approval
    planctl approve <epic_id> <task_id> <status>      # task approval

``<status>`` is one of ``approved | rejected | pending``. The CLI validates
the enum via ``click.Choice``; the runner re-validates defensively as a
belt-and-suspenders against hand-built ``SimpleNamespace`` invocations
(tests, future programmatic callers).

**Runtime-state-only (fn-732 task .2).** Approval lives canonically in the
gitignored runtime sidecar — the ``approval`` key on the per-task state file
(``.planctl/state/tasks/<id>.state.json``) and the per-epic sidecar
(``.planctl/state/epics/<id>.state.json``). ``approve`` writes ONLY the
sidecar (RMW under ``lock_task`` so a concurrent ``status`` write isn't
clobbered) and emits a read-only ``planctl_invocation`` (NULL ``subject`` /
``files``), so no ``.planctl/`` commit lands — the verb is runtime-state-only,
mirroring ``claim`` / ``block``. The reader-side fold ladder
(``merge_task_state`` / ``merge_epic_state`` in keeper and planctl) resolves
sidecar → committed def → ``pending``; a legacy committed def written before
this contract still resolves through the def rung, and keeper's def-fallback
is retained permanently.

NOT in ``VALIDATION_RESTAMP_VERBS`` — approval is human gating state, not
structural plan content; flipping it must not invalidate the epic's
``last_validated_at`` marker.

**Approval gates (fn-592 task .1).** When ``<status> == "approved"`` the
runner refuses to write unless the target is in a clean approvable state:

  * Task approve: the merged task state's ``status`` must be ``"done"``.
    (Task status lives in runtime state under ``.planctl/state/runtime/``;
    we merge def + runtime via ``merge_task_state`` and read the result.)
  * Epic approve: the epic JSON's ``status`` must be ``"done"`` AND every
    embedded task must also have merged ``status == "done"`` AND every
    embedded task must have ``approval == "approved"``.

``rejected`` and ``pending`` writes are ALWAYS allowed — the gates fire on
approve only.  External writers (keeperd's ``set_task_approval`` /
``set_epic_approval`` RPCs) bypass these gates by design; they write the
JSON directly without going through the CLI.

**Cwd-agnostic resolution.** Three-step lookup: ``--project <path>`` →
cwd → roots discovery. The cwd-first short-circuit keeps the single-repo
workflow working without configured ``roots``; discovery then covers the
multi-repo case where ``epic.primary_repo`` lives in a sibling project (the
prior cwd-only implementation failed with "Task not found" here). Ambiguous
same-id collisions across discovered projects surface as a ``--project``
disambiguation prompt rather than a silent wrong-store write.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace


def _render_human(data: dict) -> str:
    """Single-line summary for `--format human`."""
    target = data.get("task_id") or data.get("epic_id")
    return f"Approval for {target}: {data.get('approval')}"


def _context_for_root(project_root: Path):
    """Build a ProjectContext from a project root dir (the ``.planctl/`` parent)."""
    from planctl.project import ProjectContext

    planctl_dir = project_root / ".planctl"
    return ProjectContext(
        name=project_root.name,
        data_dir=planctl_dir,
        state_dir=planctl_dir / "state",
        project_path=project_root,
    )


def _target_exists_in(ctx, epic_id: str, task_id: str | None) -> bool:
    """Whether *ctx* holds the approve target's JSON on disk."""
    if task_id is not None:
        return (ctx.data_dir / "tasks" / f"{task_id}.json").exists()
    return (ctx.data_dir / "epics" / f"{epic_id}.json").exists()


def _resolve_project_for_approve(
    epic_id: str, task_id: str | None, project: str | None
):
    """Resolve the owning project for the approve target.

    Resolution order:

    1. ``--project <path>`` override: resolve that path directly, bypassing
       cwd and discovery. Fails closed if it isn't a planctl project, or if
       the target JSON (task or epic) isn't present there.
    2. Cwd: if the current directory is a planctl project AND its
       ``.planctl/`` holds the target, use it. This preserves the
       single-repo workflow (no configured ``roots`` required) that existed
       before approve became cwd-agnostic.
    3. Roots discovery: scan the configured ``roots`` for projects whose
       ``.planctl/tasks/<task_id>.json`` (task branch) or
       ``.planctl/epics/<epic_id>.json`` (epic branch) exists. Exactly one
       match → use it. Zero → not-found error. Many → ambiguous-id error
       pointing the operator at ``--project <path>``.

    The bug fix that introduced this helper (fn-620 follow-up): the prior
    implementation called ``planctl.project.resolve_project`` which is
    purely cwd-anchored, so ``/plan:approve`` from a repo whose ``.planctl/``
    did NOT own the target failed with "Task not found" even when roots
    discovery would have located it. Cwd is still checked first to preserve
    no-configured-roots single-repo behavior.
    """
    from planctl.discovery import find_projects_with_epic, find_projects_with_task
    from planctl.output import emit_error
    from planctl.project import find_project_root

    if project is not None:
        project_root = Path(project).expanduser().resolve()
        if not (project_root / ".planctl").is_dir():
            emit_error(
                f"No planctl project found at {project_root}. Run 'planctl init' first."
            )
        ctx = _context_for_root(project_root)
        if not _target_exists_in(ctx, epic_id, task_id):
            kind = "Task" if task_id is not None else "Epic"
            tgt = task_id if task_id is not None else epic_id
            emit_error(f"{kind} not found in {project_root}: {tgt}")
        return ctx

    # Cwd-first short-circuit: keeps single-repo workflows working without
    # configured roots. find_project_root falls back to cwd when not in a git
    # repo, so this is safe to attempt unconditionally.
    cwd_root = find_project_root()
    if (cwd_root / ".planctl").is_dir():
        cwd_ctx = _context_for_root(cwd_root)
        if _target_exists_in(cwd_ctx, epic_id, task_id):
            return cwd_ctx

    if task_id is not None:
        matches = find_projects_with_task(task_id)
        not_found_msg = f"Task not found: {task_id}"
        ambiguous_target = task_id
    else:
        matches = find_projects_with_epic(epic_id)
        not_found_msg = f"Epic not found: {epic_id}"
        ambiguous_target = epic_id

    if not matches:
        emit_error(not_found_msg)
    if len(matches) == 1:
        return _context_for_root(matches[0])

    candidates = ", ".join(str(p) for p in matches)
    emit_error(
        f"{ambiguous_target} exists in multiple projects; "
        f"pass --project <path>. Candidates: {candidates}"
    )


def _gate_task_approve(task_id: str, ctx, emit_error_fn) -> None:
    """Refuse approve unless the task's merged status is "done".

    Task ``status`` lives in runtime state (``.planctl/state/runtime/<task>.json``);
    the task definition JSON does not carry it.  ``merge_task_state`` fuses
    def + runtime the same way every other reader does, so the gate matches
    whatever ``planctl show`` would display.
    """
    from planctl.models import merge_task_state
    from planctl.store import LocalFileStateStore, load_json

    state_store = LocalFileStateStore(ctx.state_dir)
    task_def = load_json(ctx.data_dir / "tasks" / f"{task_id}.json")
    runtime = state_store.load_runtime(task_id)
    merged = merge_task_state(task_def, runtime)
    status = merged.get("status", "todo")
    if status != "done":
        emit_error_fn(
            f"Cannot approve task {task_id}: status is {status!r}, must be 'done'"
        )


def _gate_epic_approve(epic_id: str, epic_def: dict, ctx, emit_error_fn) -> None:
    """Refuse epic approve unless epic done + every task done + every task approved.

    Single-JSON-read per task — definition file plus its runtime state file
    (both already on disk for any task that's ever been touched).  No spec
    markdown parsing.
    """
    from planctl.models import merge_task_state
    from planctl.store import LocalFileStateStore, load_json_safe

    if epic_def.get("status") != "done":
        emit_error_fn(
            f"Cannot approve epic {epic_id}: status is "
            f"{epic_def.get('status')!r}, must be 'done'"
        )

    data_dir = ctx.data_dir
    state_store = LocalFileStateStore(ctx.state_dir)

    tasks_dir = data_dir / "tasks"
    task_files = (
        sorted(tasks_dir.glob(f"{epic_id}.*.json")) if tasks_dir.exists() else []
    )
    for tf in task_files:
        task_def = load_json_safe(tf)
        if task_def is None:
            emit_error_fn(
                f"Cannot approve epic {epic_id}: task {tf.stem} JSON unreadable"
            )
        assert task_def is not None  # narrowing past the NoReturn emit_error above
        tid = task_def.get("id", tf.stem)
        runtime = state_store.load_runtime(tid)
        merged = merge_task_state(task_def, runtime)
        tstatus = merged.get("status", "todo")
        if tstatus != "done":
            emit_error_fn(
                f"Cannot approve epic {epic_id}: task {tid} status is "
                f"{tstatus!r}, must be 'done'"
            )
        # fn-732: resolve each task's approval via the ladder. merge_task_state
        # folds the sidecar (runtime) value over the def value and applies the
        # pending tail, so `merged["approval"]` is already sidecar → def →
        # pending. The prior `task_def.get("approval", ...)` read only saw the
        # committed def and would miss a sidecar-only approval during the
        # dual-write transition.
        tapproval = merged.get("approval", "pending") or "pending"
        if tapproval != "approved":
            emit_error_fn(
                f"Cannot approve epic {epic_id}: task {tid} approval is "
                f"{tapproval!r}, must be 'approved'"
            )


def run(args: SimpleNamespace) -> int:
    from planctl.ids import is_epic_id, is_task_id
    from planctl.models import APPROVAL_STATUSES
    from planctl.output import emit, emit_error
    from planctl.store import load_json

    epic_id: str = args.epic_id
    task_id: str | None = getattr(args, "task_id", None)
    status: str = args.status
    project: str | None = getattr(args, "project", None)

    # Defensive enum check — click.Choice already gates the CLI path, but a
    # SimpleNamespace-constructed call (tests, future programmatic callers)
    # can bypass click entirely. Reject early with the standard emit_error
    # envelope rather than landing an invalid value on disk.
    if status not in APPROVAL_STATUSES:
        emit_error(
            f"Invalid approval status: {status!r}. "
            f"Must be one of: {', '.join(APPROVAL_STATUSES)}"
        )

    if not is_epic_id(epic_id):
        emit_error(f"Invalid epic ID: {epic_id}")

    # Validate the task-branch parent-epic invariant BEFORE resolving the
    # owning project — a mismatched (epic_id, task_id) pair is an operator
    # error that's independent of where the .planctl/ store lives, so surface
    # it at the boundary without a discovery scan.
    if task_id is not None:
        if not is_task_id(task_id):
            emit_error(f"Invalid task ID: {task_id}")
        from planctl.ids import epic_id_from_task

        parent_eid = epic_id_from_task(task_id)
        if parent_eid != epic_id:
            emit_error(f"Task {task_id} belongs to epic {parent_eid}, not {epic_id}")

    ctx = _resolve_project_for_approve(epic_id, task_id, project)
    data_dir = ctx.data_dir

    if task_id is not None:
        # Task-level approval. The task_id well-formedness and parent-epic
        # match were validated above (before project resolution); the
        # resolver also guarantees the task JSON exists on disk in ctx.

        # Gate: task approve requires status == done.  Rejected/pending are
        # always allowed (operator can flip a previously-approved task back
        # into the gate without re-running the worker).
        if status == "approved":
            _gate_task_approve(task_id, ctx, emit_error)

        # fn-732 CONTRACT (task .2): approval lives canonically in the
        # gitignored runtime sidecar only. The RMW under lock_task touches just
        # the approval key so a concurrent `status` write isn't clobbered.
        # planctl no longer writes or commits the def-file `approval`; keeper's
        # permanent fold ladder (sidecar → committed def → pending) still reads
        # a legacy committed def written before this contract, so no keeper is
        # starved. The def write was retained through the dual-write window
        # (task .1) and dropped here only after the end-to-end sidecar-fold
        # verify gate passed in a quiesced window.
        from planctl.store import LocalFileStateStore

        state_store = LocalFileStateStore(ctx.state_dir)
        state_store.write_task_approval(task_id, status)

        # Runtime-state-only: the sidecar is gitignored, so approve emits a
        # read-only invocation (NULL subject/files) and lands no commit —
        # mirrors `claim`/`block`. The auto-commit helper no-ops on empty files.
        from planctl.invocation import build_planctl_invocation_readonly

        pc = build_planctl_invocation_readonly(
            "approve", task_id, repo_root=ctx.project_path
        )
        emit(
            {
                "epic_id": epic_id,
                "task_id": task_id,
                "approval": status,
            },
            text_renderer=_render_human,
            planctl_invocation=pc,
        )
        return 0

    # Epic-level approval. The resolver guarantees the epic JSON exists in
    # ctx — no separate epic_path.exists() check is needed.
    epic_path = data_dir / "epics" / f"{epic_id}.json"
    epic_def = load_json(epic_path)

    # Gate: epic approve requires epic status == done AND every embedded task
    # status == done AND every embedded task approval == approved.  Mirrors
    # the client-side gate that previously lived in keeper's approve.ts
    # (deleted by this epic).  Rejected/pending writes are unguarded.
    if status == "approved":
        _gate_epic_approve(epic_id, epic_def, ctx, emit_error)

    # fn-732 CONTRACT (task .2) — same contract as the task branch above. The
    # epic runtime sidecar (.planctl/state/epics/<id>.state.json) is the sole
    # write target; planctl no longer writes or commits the def-file approval.
    # keeper's permanent fold ladder (sidecar → committed def → pending) reads
    # any legacy committed def, so no keeper is starved.
    from planctl.store import LocalFileStateStore

    state_store = LocalFileStateStore(ctx.state_dir)
    state_store.write_epic_approval(epic_id, status)

    # Runtime-state-only: gitignored sidecar write, read-only invocation
    # (NULL subject/files), no commit — mirrors `claim`/`block`.
    from planctl.invocation import build_planctl_invocation_readonly

    pc = build_planctl_invocation_readonly(
        "approve", epic_id, repo_root=ctx.project_path
    )
    emit(
        {
            "epic_id": epic_id,
            "approval": status,
        },
        text_renderer=_render_human,
        planctl_invocation=pc,
    )
    return 0
