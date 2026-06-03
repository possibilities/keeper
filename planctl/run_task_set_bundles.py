"""planctl task set-bundles — replace the bundle-ref list on a task (fn-513).

Replace-only semantics (mirrors ``set-deps`` / ``set-touched-repos``): the
``--bundles`` value fully replaces ``task.bundles``. ``--bundles ""`` (or
``--bundles`` with no value) clears the list. No ``--append`` flag.

Each bundle ref must match::

    ^(bundle|arc|sketch)/[a-z][a-z0-9-]*(/[a-z][a-z0-9-]*)?$

which admits ``bundle/dev-env``, ``arc/snippeting/main``,
``sketch/runtime-substrate`` and rejects path-traversal (``arc/foo/../etc``)
before the ref ever flows into a shell at inheritor-tier render time.

Joins ``VALIDATION_RESTAMP_VERBS`` — replacing the bundle list is a structural
change to spec metadata, so the parent epic's ``last_validated_at`` is cleared.
"""

from __future__ import annotations

from types import SimpleNamespace

from planctl.bundle_ref import BUNDLE_REF_RE


def _render_human(data: dict) -> str:
    bundles = data.get("bundles", [])
    body = ", ".join(bundles) if bundles else "(cleared)"
    return f"Set bundles for {data.get('task_id')}: {body}"


def run(args: SimpleNamespace) -> int:
    from planctl.ids import epic_id_from_task, is_task_id
    from planctl.models import normalize_task
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.store import atomic_write_json, load_json, now_iso

    task_id: str = args.task_id
    bundles_arg: str | None = args.bundles

    if not is_task_id(task_id):
        emit_error(f"Invalid task ID: {task_id}")

    raw = bundles_arg or ""
    bundles = [b.strip() for b in raw.split(",") if b.strip()]

    for ref in bundles:
        if not BUNDLE_REF_RE.match(ref):
            emit_error(
                f"Invalid bundle ref: {ref!r}. Must match "
                "(bundle|arc|sketch)/<name>[/<name>] with kebab-case segments."
            )

    ctx = resolve_project()
    data_dir = ctx.data_dir

    task_path = data_dir / "tasks" / f"{task_id}.json"
    if not task_path.exists():
        emit_error(f"Task not found: {task_id}")

    task_def = normalize_task(load_json(task_path))

    # fn-610 / fn-628: inline `sketch/` refs against the cwd-derived project
    # (where /sketch saved the sketch). Inlined ids fold into the task's
    # existing `snippets`; sketch refs are dropped from the persisted
    # `bundles` so worker-time `render-spec` never re-resolves them. The
    # resolver runs in a subprocess (`promptctl inline-sketch-refs`) — see
    # `planctl/sketch_refs.py`. Failure surfaces as the verb's existing
    # single-error envelope.
    from planctl.sketch_refs import SketchRefError, _OkSlot, inline_sketch_refs_batch

    existing_snippets = list(task_def.get("snippets", []))
    slots = inline_sketch_refs_batch(
        [{"bundles": bundles, "snippets": existing_snippets}],
        project_root=ctx.project_path,
    )
    slot = slots[0]
    if isinstance(slot, SketchRefError):
        emit_error(f"Invalid sketch ref {slot.ref!r}: {slot.reason}")
    assert isinstance(slot, _OkSlot)
    bundles = slot.remaining_bundles
    merged_snippets = slot.merged_snippets

    task_def["bundles"] = bundles
    task_def["snippets"] = merged_snippets
    task_def["updated_at"] = now_iso()
    atomic_write_json(task_path, task_def)

    # fn-587 task .4: re-stamp validation marker on the parent epic after the
    # structural write lands.  Replacing the bundle list is a structural spec-
    # metadata change (mirrors set-deps); the shared helper validates the
    # post-mutation tree and either returns a fresh stamp or emits a failure
    # envelope.
    from planctl.validation_restamp import restamp_epic_or_fail

    epic_id = epic_id_from_task(task_id)
    epic_path = data_dir / "epics" / f"{epic_id}.json"
    if epic_path.exists():
        new_stamp = restamp_epic_or_fail(epic_id, data_dir, verb="set-bundles")
        epic_def = load_json(epic_path)
        epic_def["updated_at"] = now_iso()
        epic_def["last_validated_at"] = new_stamp
        atomic_write_json(epic_path, epic_def)

    # fn-629 task .3: route through the central seam. Rewrite of pre-existing
    # tracked files (atomic_write rename-atomic) → no unwind.
    emit(
        {"task_id": task_id, "bundles": bundles},
        text_renderer=_render_human,
        verb="set-bundles",
        target=task_id,
        repo_root=ctx.project_path,
        written_paths=[],
    )
    return 0
