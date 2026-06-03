"""planctl epic set-snippets — replace the snippet-id list on an epic (fn-513).

Replace-only semantics (mirrors ``set-touched-repos``): the ``--snippets``
value fully replaces ``epic.snippets``.  ``--snippets ""`` (or ``--snippets``
with no value) clears the list.  No ``--append`` flag.

Snippet ids are validated as non-empty kebab-case strings only; no existence
check (phantom ids surface as warnings at ``promptctl render-spec`` time per
the Epic 1 runtime-substrate design).

Joins ``VALIDATION_RESTAMP_VERBS`` — replacing the snippet list is a structural
change to spec metadata, so ``last_validated_at`` is cleared on the epic.
"""

from __future__ import annotations

from types import SimpleNamespace

from planctl.bundle_ref import SNIPPET_ID_RE


def _render_human(data: dict) -> str:
    snippets = data.get("snippets", [])
    body = ", ".join(snippets) if snippets else "(cleared)"
    return f"Set snippets for {data.get('epic_id')}: {body}"


def run(args: SimpleNamespace) -> int:
    from planctl.ids import is_epic_id
    from planctl.models import normalize_epic
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.store import atomic_write_json, load_json, now_iso

    epic_id: str = args.epic_id
    snippets_arg: str | None = args.snippets

    if not is_epic_id(epic_id):
        emit_error(f"Invalid epic ID: {epic_id}")

    raw = snippets_arg or ""
    snippets = [s.strip() for s in raw.split(",") if s.strip()]

    for sid in snippets:
        if not SNIPPET_ID_RE.match(sid):
            emit_error(
                f"Invalid snippet id: {sid!r}. Must be non-empty kebab-case "
                "(lowercase alnum, single dashes)."
            )

    ctx = resolve_project()
    data_dir = ctx.data_dir

    epic_path = data_dir / "epics" / f"{epic_id}.json"
    if not epic_path.exists():
        emit_error(f"Epic not found: {epic_id}")

    epic_def = normalize_epic(load_json(epic_path))
    epic_def["snippets"] = snippets
    epic_def["updated_at"] = now_iso()
    atomic_write_json(epic_path, epic_def)

    # fn-587 task .4: re-stamp last_validated_at after the structural write.
    # The shared helper validates the post-mutation tree and either returns
    # a fresh stamp or emits a structured failure envelope.
    from planctl.validation_restamp import restamp_epic_or_fail

    new_stamp = restamp_epic_or_fail(epic_id, data_dir, verb="set-snippets")
    epic_def = load_json(epic_path)
    epic_def["last_validated_at"] = new_stamp
    atomic_write_json(epic_path, epic_def)

    primary_repo: str | None = epic_def.get("primary_repo")
    # fn-629 task .3: route through the central seam. Rewrite of a
    # pre-existing tracked file (atomic_write rename-atomic) → no unwind.
    emit(
        {"epic_id": epic_id, "snippets": snippets},
        text_renderer=_render_human,
        verb="set-snippets",
        target=epic_id,
        repo_root=ctx.project_path,
        primary_repo=primary_repo,
        written_paths=[],
    )
    return 0
