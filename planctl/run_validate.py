"""planctl validate - Validate project data integrity."""

from __future__ import annotations

from types import SimpleNamespace

# fn-587 task .3: ``_validate_repo_path`` is the canonical helper now exported
# from ``planctl.integrity``.  Keep a re-export here for back-compat with
# verbs (``run_epic_set_primary_repo`` / ``run_epic_set_touched_repos``) that
# already ``from planctl.run_validate import _validate_repo_path``.  Inline
# users below also resolve through this name.
from planctl.integrity import _validate_repo_path

__all__ = ("_validate_repo_path",)


def _render_human_validate(data: dict) -> str:
    """Render validate envelope as human-readable text."""
    errors = data.get("errors", [])
    warnings = data.get("warnings", [])
    valid = data.get("valid", False)
    lines = []
    if errors:
        lines.append("\nErrors:")
        for e in errors:
            lines.append(f"  - {e}")
    if warnings:
        lines.append("\nWarnings:")
        for w in warnings:
            lines.append(f"  - {w}")
    if valid and not warnings:
        lines.append("\nValidation passed.")
    elif valid:
        lines.append(f"\nValidation passed with {len(warnings)} warning(s).")
    else:
        lines.append(
            f"\nValidation failed with {len(errors)} error(s) and {len(warnings)} warning(s)."
        )
    return "\n".join(lines)


def run(args: SimpleNamespace) -> int:
    import json

    from planctl._util import format_output
    from planctl.integrity import validate_epic_integrity_with_warnings
    from planctl.models import SCHEMA_VERSION
    from planctl.project import resolve_project
    from planctl.store import (
        atomic_write_json,
        load_json,
        load_json_safe,
        now_iso,
    )

    epic_id: str | None = args.epic_id

    ctx = resolve_project()
    data_dir = ctx.data_dir

    errors: list[str] = []
    warnings: list[str] = []

    # Root validation
    meta = load_json_safe(data_dir / "meta.json")
    if meta is None:
        errors.append("meta.json is missing or invalid")
    else:
        sv = meta.get("schema_version")
        if sv != SCHEMA_VERSION:
            errors.append(f"Unsupported schema_version: {sv}")

    for d in ["epics", "specs", "tasks"]:
        if not (data_dir / d).exists():
            errors.append(f"Required directory missing: {d}/")

    # Collect epics to validate
    epics_dir = data_dir / "epics"
    all_epic_ids: set[str] = set()

    if epics_dir.exists():
        for f in epics_dir.glob("*.json"):
            all_epic_ids.add(f.stem)

    epic_ids_to_check: list[str] = [epic_id] if epic_id else sorted(all_epic_ids)

    # fn-587 task .3: per-epic structural integrity now lives in
    # ``planctl.integrity.validate_epic_integrity_with_warnings`` — same call
    # site, same error list shape, shared with scaffold's fresh-mint check.
    for eid in epic_ids_to_check:
        ep_errors, ep_warnings = validate_epic_integrity_with_warnings(eid, data_dir)
        errors.extend(ep_errors)
        warnings.extend(ep_warnings)

    valid = len(errors) == 0

    # validate has a non-standard envelope: {valid, errors, warnings} — not {success, ...}
    # Route through format_output directly, not emit().
    format_output(
        {"valid": valid, "errors": errors, "warnings": warnings},
        text_renderer=_render_human_validate,
    )

    # Marker-write: only when --epic <id> is given, only on valid=True, only on
    # None → timestamp transition. Re-validation of an already-stamped epic is
    # a no-op (no atomic_write_json, no NDJSON line, no commit).
    if valid and epic_id:
        import sys

        from planctl import commit
        from planctl.invocation import build_planctl_invocation

        epic_path = data_dir / "epics" / f"{epic_id}.json"
        epic_def = load_json(epic_path)
        if epic_def.get("last_validated_at") is None:
            # Transition: None → timestamp. Write marker and emit invocation.
            epic_def["last_validated_at"] = now_iso()
            epic_def["updated_at"] = now_iso()
            atomic_write_json(epic_path, epic_def)

            primary_repo: str | None = epic_def.get("primary_repo")
            pc = build_planctl_invocation(
                "validate",
                epic_id,
                repo_root=ctx.project_path,
                primary_repo=primary_repo,
            )
            # Per-verb auto-commit. Runs BEFORE the NDJSON invocation line
            # prints, so the printed line is the authoritative signal that the
            # `.planctl/` commit landed. On any hard commit failure, emit a
            # structured failure envelope to stdout and exit 1 — the
            # invocation line is NOT printed.
            try:
                commit.auto_commit_from_invocation(pc)
            except commit.CommitFailed as exc:
                failure = {
                    "success": False,
                    "error": "commit_failed",
                    "details": {
                        "error": exc.error,
                        "message": exc.message,
                        **exc.extra,
                    },
                    "planctl_invocation": pc,
                }
                print(json.dumps(failure, separators=(",", ":")), flush=True)
                sys.exit(1)

            print(json.dumps({"planctl_invocation": pc}))

    return 0 if valid else 1
