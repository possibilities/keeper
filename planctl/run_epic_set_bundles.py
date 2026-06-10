"""planctl epic set-bundles — replace the bundle-ref list on an epic.

Replace-only semantics (mirrors ``set-touched-repos``): the ``--bundles``
value fully replaces ``epic.bundles``.  ``--bundles ""`` (or ``--bundles``
with no value) clears the list.  No ``--append`` flag.

Each bundle ref must match::

    ^(bundle|sketch)/[a-z][a-z0-9-]*(/[a-z][a-z0-9-]*)?$

which admits ``bundle/dev-env``, ``bundle/snippeting-main``,
``sketch/runtime-substrate`` and rejects path-traversal (``bundle/foo/../etc``)
before the ref ever flows into a shell at inheritor-tier render time.

Joins ``VALIDATION_RESTAMP_VERBS`` — replacing the bundle list is a structural
change to spec metadata, so ``last_validated_at`` is cleared on the epic.
"""

from __future__ import annotations

from types import SimpleNamespace

from planctl.bundle_ref import BUNDLE_REF_RE


def _render_human(data: dict) -> str:
    bundles = data.get("bundles", [])
    body = ", ".join(bundles) if bundles else "(cleared)"
    return f"Set bundles for {data.get('epic_id')}: {body}"


def run(args: SimpleNamespace) -> int:
    from planctl.ids import is_epic_id
    from planctl.models import normalize_epic
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.store import atomic_write_json, load_json, now_iso

    epic_id: str = args.epic_id
    bundles_arg: str | None = args.bundles

    if not is_epic_id(epic_id):
        emit_error(f"Invalid epic ID: {epic_id}")

    raw = bundles_arg or ""
    bundles = [b.strip() for b in raw.split(",") if b.strip()]

    for ref in bundles:
        if not BUNDLE_REF_RE.match(ref):
            emit_error(
                f"Invalid bundle ref: {ref!r}. Must match "
                "(bundle|sketch)/<name>[/<name>] with kebab-case segments."
            )

    ctx = resolve_project()
    data_dir = ctx.data_dir

    epic_path = data_dir / "epics" / f"{epic_id}.json"
    if not epic_path.exists():
        emit_error(f"Epic not found: {epic_id}")

    epic_def = normalize_epic(load_json(epic_path))

    # Inline `sketch/` refs against the cwd-derived project
    # (where /sketch saved the sketch). Inlined ids fold into the epic's
    # existing `snippets`; sketch refs are dropped from the persisted
    # `bundles` so worker-time `render-spec` never re-resolves them. The
    # resolver runs in a subprocess (`promptctl inline-sketch-refs`) — see
    # `planctl/sketch_refs.py` — so planctl carries zero in-repo Python
    # dependency on promptctl. Failure surfaces as the verb's existing
    # single-error envelope (no collect-all — one ref per resolution).
    from planctl.sketch_refs import SketchRefError, _OkSlot, inline_sketch_refs_batch

    existing_snippets = list(epic_def.get("snippets", []))
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

    epic_def["bundles"] = bundles
    epic_def["snippets"] = merged_snippets
    epic_def["updated_at"] = now_iso()
    atomic_write_json(epic_path, epic_def)

    # Re-stamp last_validated_at after the structural write.
    # The shared helper validates the post-mutation tree and either returns
    # a fresh stamp or emits a structured failure envelope.
    from planctl.validation_restamp import restamp_epic_or_fail

    new_stamp = restamp_epic_or_fail(epic_id, data_dir, verb="set-bundles")
    epic_def = load_json(epic_path)
    epic_def["last_validated_at"] = new_stamp
    atomic_write_json(epic_path, epic_def)

    primary_repo: str | None = epic_def.get("primary_repo")
    # Route through the central seam. Rewrite of a
    # pre-existing tracked file (atomic_write rename-atomic) → no unwind.
    emit(
        {"epic_id": epic_id, "bundles": bundles},
        text_renderer=_render_human,
        verb="set-bundles",
        target=epic_id,
        repo_root=ctx.project_path,
        primary_repo=primary_repo,
    )
    return 0
