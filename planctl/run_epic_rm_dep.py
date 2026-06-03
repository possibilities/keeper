"""planctl epic rm-dep - Remove an epic-level dependency."""

from __future__ import annotations

from types import SimpleNamespace


def _render_human(data: dict) -> str:
    eid = data.get("epic_id")
    # dep_id isn't in the envelope, reconstruct message from deps list
    deps = data.get("depends_on_epics", [])
    return f"Removed dependency from {eid}; now depends on: {', '.join(deps) if deps else '(none)'}"


def run(args: SimpleNamespace) -> int:
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.store import atomic_write_json, load_json, now_iso

    epic_id: str = args.epic_id
    dep_id: str = args.dep_id

    ctx = resolve_project()
    data_dir = ctx.data_dir

    epic_path = data_dir / "epics" / f"{epic_id}.json"
    if not epic_path.exists():
        emit_error(f"Epic not found: {epic_id}")

    epic_def = load_json(epic_path)
    deps = epic_def.get("depends_on_epics", [])

    # Idempotent removal
    if dep_id in deps:
        deps.remove(dep_id)

    epic_def["depends_on_epics"] = deps
    epic_def["updated_at"] = now_iso()
    atomic_write_json(epic_path, epic_def)

    # fn-587 task .4: re-stamp last_validated_at after the structural write.
    # Edge removal is monotonic (cannot introduce a cycle) so the post-write
    # integrity check is a defensive backstop — same code shape as add-dep
    # for symmetry across the dep-wiring verbs.
    from planctl.validation_restamp import restamp_epic_or_fail

    new_stamp = restamp_epic_or_fail(epic_id, data_dir, verb="rm-dep")
    epic_def = load_json(epic_path)
    epic_def["last_validated_at"] = new_stamp
    atomic_write_json(epic_path, epic_def)

    # fn-629 task .3: route through the central seam. Rewrite of a
    # pre-existing tracked file (atomic_write rename-atomic) → no unwind.
    emit(
        {"epic_id": epic_id, "depends_on_epics": deps},
        text_renderer=_render_human,
        verb="rm-dep",
        target=epic_id,
        repo_root=ctx.project_path,
    )
    return 0
