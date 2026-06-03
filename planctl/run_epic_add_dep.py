"""planctl epic add-dep - Add an epic-level dependency.

fn-600: epic-level dep existence is resolved cwd-then-global via
``discovery.resolve_epic_globally`` so a dep id that lives in a sibling
project (epic A in project X depended on by epic B in project Y) wires
cleanly. Legacy dup state where the same id appears in two projects
surfaces as an ``Epic exists in multiple projects`` error rather than a
silent last-walked pick.
"""

from __future__ import annotations

from types import SimpleNamespace


def _render_human(data: dict) -> str:
    deps = data.get("depends_on_epics", [])
    return f"Set epic deps for {data.get('epic_id')}: {', '.join(deps) or '(none)'}"


def run(args: SimpleNamespace) -> int:
    from planctl.discovery import resolve_epic_globally
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
    if epic_id == dep_id:
        emit_error(f"Epic cannot depend on itself: {epic_id}")

    # fn-600: dep existence is resolved globally so cross-project deps wire.
    # ``resolve_epic_globally`` is cwd-then-global, so the local-dep hot path
    # still short-circuits without scanning sibling projects. Ambiguous-id
    # (legacy dup state) surfaces as a hard error here — no silent pick.
    dep_resolution = resolve_epic_globally(dep_id)
    if dep_resolution.ambiguous:
        owners = ", ".join(str(p) for p in dep_resolution.owners)
        emit_error(
            f"Epic {dep_id} exists in multiple projects (cannot wire dep): {owners}"
        )
    if not dep_resolution.resolved:
        emit_error(f"Epic not found: {dep_id}")

    pre_write_epic_def = load_json(epic_path)
    deps = list(pre_write_epic_def.get("depends_on_epics", []))

    if dep_id in deps:
        emit_error(f"Dependency already exists: {epic_id} -> {dep_id}")

    deps.append(dep_id)
    epic_def = dict(pre_write_epic_def)
    epic_def["depends_on_epics"] = deps
    epic_def["updated_at"] = now_iso()
    atomic_write_json(epic_path, epic_def)

    # fn-587 task .4: re-stamp last_validated_at after the structural write.
    # fn-588 task .1: the shared helper now walks the project-wide epic-dep
    # graph for cycles in addition to its existing task-graph cycle check, so
    # this single-edge verb (which does NO pre-write cycle assertion of its
    # own — unlike add-deps and refine-apply) catches a freshly-introduced
    # A -> B -> A cycle via the post-write integrity gate.  Helper either
    # returns a fresh stamp or emits a failure envelope.
    # fn-590 task .1: roll the dep write back if the post-write integrity
    # gate raises (e.g. cycle), so a rejected dep leaves disk untouched.
    from planctl.validation_restamp import restamp_epic_or_fail

    try:
        new_stamp = restamp_epic_or_fail(epic_id, data_dir, verb="add-dep")
    except BaseException:
        atomic_write_json(epic_path, pre_write_epic_def)
        raise
    epic_def = load_json(epic_path)
    epic_def["last_validated_at"] = new_stamp
    atomic_write_json(epic_path, epic_def)

    # fn-629 task .3: route through the central seam. Rewrite of a
    # pre-existing tracked file (atomic_write rename-atomic) → no unwind.
    emit(
        {"epic_id": epic_id, "depends_on_epics": deps},
        text_renderer=_render_human,
        verb="add-dep",
        target=epic_id,
        repo_root=ctx.project_path,
    )
    return 0
