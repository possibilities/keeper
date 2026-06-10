"""Canonical list of planctl verbs that re-stamp last_validated_at on mutation.

Any verb that touches an epic's tasks, deps, or specs must appear here.
The coverage test in tests/test_validate_marker.py walks this list and
asserts that each verb re-stamps the marker (post-write timestamp strictly
newer than pre-write) on success.

On success each listed verb re-stamps the marker to a fresh timestamp after a
post-write integrity re-check.  ``epic invalidate`` is the only verb that nulls
the marker.

Verbs that do NOT re-stamp (no validation-relevant structural change):
  done, claim, block, epic close, epic set-branch, epic set-title
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import NoReturn

# Verbs that re-stamp last_validated_at on mutation.
# Add new task/dep/spec mutating verbs here as they are created.
#
# There are no incremental `task-create` / `set-spec` / `set-deps` /
# `dep-add` / `set-plan` entries — those structural changes ride `scaffold`
# (mint; NOT in this tuple) and `refine-apply` (rewrite an existing tree; IS
# in this tuple).
VALIDATION_RESTAMP_VERBS: tuple[str, ...] = (
    "set-description",
    "set-acceptance",
    "reset",
    "add-dep",
    # Batch epic-dep wirer — same structural effect as add-dep (wires
    # epic-level edges), so it re-stamps the marker alongside the single-edge verb.
    "add-deps",
    "rm-dep",
    "set-primary-repo",
    "set-touched-repos",
    "set-target-repo",
    # Spec-metadata setters — replacing the snippet/bundle list is a
    # structural spec change. Shared verb name across the
    # task and epic surfaces; both re-stamp the marker.
    "set-snippets",
    "set-bundles",
    # refine-apply rewrites specs/deps on an EXISTING epic tree (adds,
    # spec-rewrites, dep-rewires, epic-spec rewrite) — a structural change that
    # must re-stamp the marker. This is the core asymmetry with `scaffold`,
    # which mints a fresh epic and is NOT in this tuple.
    "refine-apply",
)


def restamp_epic_or_fail(
    epic_id: str,
    data_dir: Path,
    *,
    verb: str,
    check_filesystem_repos: bool = False,
) -> str:
    """Re-validate the epic on disk and return a fresh stamp, or abort.

    Used by the 14 ``VALIDATION_RESTAMP_VERBS`` runners AFTER they have written
    their structural change to disk.  Re-runs the shared per-epic integrity
    check (``planctl.integrity.validate_epic_integrity``) against the post-
    mutation tree.  On a clean result, returns ``now_iso()`` — the caller
    writes it back to the epic JSON's ``last_validated_at`` in the same epic-
    write so the marker reflects the validity of the tree at write time.

    On any structural error, emits a structured failure envelope on stdout
    and ``sys.exit(1)``.  The caller's structural write has already landed at
    that point — the epic JSON keeps the stale ``last_validated_at`` value;
    the dispatch-observer's ``current_stamp != stored_stamp`` check soft-
    disarms armed keeper rows regardless (the stamp change vs null both
    fire the same comparison).  The failure envelope shape is the standard
    ``{success, error: {code, message, details}}`` used by ``scaffold`` /
    ``refine-apply`` / ``epic add-deps``.

    Why post-write rather than pre-write: most callers already mutate task
    JSONs / spec files / epic.touched_repos before they touch
    ``last_validated_at``.  Validating the in-memory plan before write would
    require each verb to assemble a tree snapshot — symmetric across 14
    runners but invasive.  The post-write check is simpler and the worst
    case (writes landed, marker stays stale) is benign: dispatch-observer
    fires soft-disarm, ``epic invalidate`` clears explicitly if desired.

    ``check_filesystem_repos``: when True, the
    post-write integrity check additionally asserts that ``primary_repo`` /
    ``touched_repos`` / per-task ``target_repo`` paths resolve to real
    ``.git/``-bearing dirs.  Default False preserves the warn-and-write
    semantics for the set-*-repo verbs (a path may be staged for a move that
    hasn't landed yet).  ``refine-apply`` opts in so the trailing
    ``planctl validate --epic`` the skill used to fire is no longer needed.
    """
    from planctl.integrity import _check_epic_tree
    from planctl.project import resolve_project
    from planctl.store import LocalFileStateStore, load_json_safe, now_iso

    # Load the on-disk tree and run the shape/structural slice of the
    # integrity check.  ``check_filesystem_repos=False`` is intentional: the
    # set-*-repo verbs have warn-and-write semantics for filesystem path
    # validity (a path may be staged for a move that hasn't landed yet — see
    # ``apps/planctl/planctl/run_epic_set_primary_repo.py``), so the post-
    # write re-stamp gate restricts itself to shape / cycle / dep-existence
    # / spec-headings errors.  The filesystem-repo check is the
    # ``planctl validate --epic`` job, not the per-verb re-stamp gate.
    epic_path = data_dir / "epics" / f"{epic_id}.json"
    epic_data = load_json_safe(epic_path)
    if epic_data is None:
        _emit_restamp_failure(
            verb,
            epic_id,
            [f"Epic {epic_id}: definition file is missing or invalid JSON"],
        )

    # Build the all-epics set for depends_on_epics existence checks plus the
    # parallel ``{epic_id: depends_on_epics}`` map used by the integrity
    # helper's epic-dep cycle check.  Single glob covers
    # both — the loads are cheap and the map is the only way the post-write
    # gate catches a freshly-introduced A -> B -> A cycle via ``add-dep``
    # (whose own runner does NOT pre-check the epic-dep graph).
    epics_dir = data_dir / "epics"
    all_epic_ids: set[str] = set()
    all_epic_deps: dict[str, list[str]] = {}
    if epics_dir.exists():
        for f in epics_dir.glob("*.json"):
            all_epic_ids.add(f.stem)
            ep = load_json_safe(f)
            if ep is None:
                continue
            all_epic_deps[f.stem] = list(ep.get("depends_on_epics", []))
    # Overlay the epic under check with its post-mutation deps so the cycle
    # walk sees the freshest view (the glob already covers it, but this
    # guards against a stale read race).  ``epic_data`` is guaranteed non-None
    # past the ``_emit_restamp_failure`` guard above (``NoReturn``), but ty
    # doesn't narrow across the helper — assert and move on.
    assert epic_data is not None
    all_epic_deps[epic_id] = list(epic_data.get("depends_on_epics", []))

    # Extend existence + cycle universe across every discovered
    # project so cross-project deps resolve cleanly and a cross-project
    # A -> B -> A cycle introduced via ``add-dep`` surfaces in the
    # post-write gate. Fail-soft on discovery (empty roots / fresh install
    # / no config) → empty global map, single-project semantics preserved.
    from planctl.discovery import discover_projects
    from planctl.ids import scan_epic_ids_global

    try:
        discovered = discover_projects()
    except Exception:
        discovered = []
    all_global_epic_ids = scan_epic_ids_global(discovered) if discovered else {}
    if discovered:
        for project in discovered:
            other_epics = project / ".planctl" / "epics"
            if not other_epics.exists():
                continue
            for f in other_epics.glob("*.json"):
                if f.stem in all_epic_deps:
                    continue
                ep = load_json_safe(f)
                if ep is None:
                    continue
                all_epic_deps[f.stem] = list(ep.get("depends_on_epics", []))

    # Load tasks belonging to this epic + their spec contents.
    task_defs: dict[str, dict] = {}
    task_spec_contents: dict[str, str | None] = {}
    load_errors: list[str] = []
    tasks_dir = data_dir / "tasks"
    if tasks_dir.exists():
        for tf in tasks_dir.glob(f"{epic_id}.*.json"):
            task_data = load_json_safe(tf)
            if task_data is None:
                load_errors.append(f"Task {tf.stem}: definition file is invalid JSON")
                continue
            tid = task_data.get("id", tf.stem)
            task_defs[tid] = task_data
            task_spec_path = data_dir / "specs" / f"{tid}.md"
            if task_spec_path.exists():
                task_spec_contents[tid] = task_spec_path.read_text(encoding="utf-8")
            else:
                task_spec_contents[tid] = None

    try:
        ctx = resolve_project()
        state_store: LocalFileStateStore | None = LocalFileStateStore(ctx.state_dir)
    except Exception:  # pragma: no cover — resolve_project rarely fails post-init
        state_store = None

    core_errors, _warnings = _check_epic_tree(
        epic_id,
        epic_data,
        task_defs,
        task_spec_contents,
        data_dir=data_dir,
        all_epic_ids=all_epic_ids,
        state_store=state_store,
        check_filesystem_repos=check_filesystem_repos,
        all_epic_deps=all_epic_deps,
        all_global_epic_ids=all_global_epic_ids,
    )
    errors = load_errors + core_errors
    if errors:
        _emit_restamp_failure(verb, epic_id, errors)
    return now_iso()


def _emit_restamp_failure(verb: str, epic_id: str, errors: list[str]) -> NoReturn:
    """Emit the structured failure envelope and exit non-zero.

    Bypasses ``output.emit`` because the structural write already landed and
    a normal success envelope would be misleading.  Matches the compact-JSON
    shape used by ``scaffold`` / ``refine-apply`` / ``epic add-deps``.
    """
    envelope = {
        "success": False,
        "error": {
            "code": "integrity_failed",
            "message": (
                f"{verb} on {epic_id} produced an invalid epic tree; "
                f"last_validated_at NOT re-stamped"
            ),
            "details": errors,
        },
    }
    print(json.dumps(envelope, separators=(",", ":")), flush=True)
    sys.exit(1)


__all__ = (
    "VALIDATION_RESTAMP_VERBS",
    "restamp_epic_or_fail",
)
