"""Shared per-epic structural-integrity check (fn-587 task .3).

Factored out of ``run_validate.py``'s ``--epic`` block so scaffold (fresh-mint)
and refine-apply (rewrite) can run the same check before stamping
``last_validated_at`` on the epic JSON.  Same call site, same error list shape,
same coverage — disk-loading and in-memory paths converge through one private
core (``_check_epic_tree``).

Coverage (matches the legacy ``run_validate.py:--epic`` block 1:1):

- meta fields on the epic JSON (id / title / status / status-in-enum)
- ``approval`` enum (epic and per-task)
- epic spec file present
- epic-level ``depends_on_epics`` shape + existence
- epic-level ``depends_on_epics`` cycle detection across the project's
  epic-dep graph (requires the caller to pass ``all_epic_deps``)
- multi-repo fields (``primary_repo`` / ``touched_repos``) when present —
  filesystem ``.git/`` checks
- per-task fields (id / epic / title / status / approval / preferred_backend)
- task spec heading validation
- task-level ``depends_on`` shape + cross-epic check
- dep existence + cycle detection across the epic's task graph
- epic-done coherence (every task must be done if epic is done)
- per-task ``target_repo`` filesystem validity + touched_repos coverage

The ``state_store`` argument is optional — when ``None`` (e.g. scaffold's
fresh-mint path where no runtime state exists yet), task-status checks fall
back to the JSON's spec-side status.  ``run_validate.py:--epic`` always passes
a real state_store so its semantics are unchanged.

Two public entry points:

- :func:`validate_epic_integrity` — loads the tree from disk and runs the check
- :func:`check_epic_tree_in_memory` — runs the check against a pre-assembled
  in-memory tree (scaffold's path; the YAML-derived tree is already in RAM, so
  hitting disk would be a wasteful second pass)

``_validate_repo_path`` is re-exported here so structural verbs that already
import it from ``run_validate.py`` can migrate gradually — the old import path
in ``run_validate.py`` stays alive as a re-export for back-compat.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from planctl.store import LocalFileStateStore


def _validate_repo_path(path_str: str, label: str) -> str | None:
    """Return an error string if *path_str* is not a valid git repo, else None.

    Canonical implementation — ``run_validate.py`` re-exports this name for
    back-compat with existing call sites (``run_epic_set_primary_repo`` /
    ``run_epic_set_touched_repos``).
    """
    p = Path(path_str)
    if not p.exists():
        return f"{label}: path does not exist: {path_str}"
    if not (p / ".git").exists():
        return f"{label}: path exists but contains no .git/: {path_str}"
    return None


def _check_epic_tree(  # noqa: PLR0912, PLR0915 — single linear check matches legacy block
    eid: str,
    epic_data: dict,
    task_defs: dict[str, dict],
    task_spec_contents: Mapping[str, str | None],
    *,
    data_dir: Path,
    all_epic_ids: set[str],
    state_store: LocalFileStateStore | None,
    check_filesystem_repos: bool = True,
    all_epic_deps: dict[str, list[str]] | None = None,
    all_global_epic_ids: dict[str, Path] | None = None,
    epic_spec_content: str | None = None,
) -> tuple[list[str], list[str]]:
    """Pure-function integrity check returning ``(errors, warnings)``.

    Parameters
    ----------
    eid:
        Epic id under check.
    epic_data:
        Already-loaded epic JSON dict.
    task_defs:
        ``{task_id: task_json_dict}`` for every task belonging to this epic.
    task_spec_contents:
        ``{task_id: spec_text or None}`` — None means the spec file is missing
        (the disk path raised FileNotFoundError or the scaffold caller hasn't
        materialised the spec yet).  In-memory callers pass the YAML-supplied
        spec text directly.
    data_dir:
        Project ``.planctl/`` directory — used to check the epic spec file
        existence.  In-memory callers pass the real data_dir so the spec-file
        check works identically (scaffold writes the file before this call
        when invoked post-write; pre-write callers skip the spec check by
        ensuring the file is present).
    all_epic_ids:
        Set of all epic ids in the project (for ``depends_on_epics`` existence
        checks).
    state_store:
        Optional runtime state store.  None on the scaffold/refine-apply
        fresh-write path where no runtime state exists yet — task status falls
        back to the spec-side ``status`` field.
    check_filesystem_repos:
        When True (the ``validate --epic`` default), ``primary_repo`` /
        ``touched_repos`` / per-task ``target_repo`` paths are checked for
        ``.git/`` presence and the samefile mis-location constraint.  Scaffold
        passes False because epic JSON is designed to ship across machines
        (artbird auto-deploy) and the resolved paths may not exist as git repos
        on the minting host — the filesystem check is the worker-spawn /
        ``validate --epic`` job, not scaffold-mint's.  Shape, samefile, and
        touched_repos-coverage warnings still fire either way.
    all_epic_deps:
        Optional ``{epic_id: depends_on_epics}`` map covering every epic in
        the project (must include *eid* itself with its post-mutation dep
        list).  When provided, the helper walks the epic-dep graph for cycles
        the same way it walks the task graph and reports any cycle as an
        integrity error.  When None, the epic-dep cycle check is skipped —
        callers that don't have the full epic universe loaded (e.g. legacy
        test fixtures) keep working but lose this coverage.
    all_global_epic_ids:
        Optional ``{epic_id: project_path}`` map covering every epic in every
        discovered project (the output of ``ids.scan_epic_ids_global``).  When
        provided alongside *all_epic_ids*, the ``depends_on_epics`` existence
        check first looks in *all_epic_ids* (the project-local set, the
        canonical hot path) and then in *all_global_epic_ids* (the cross-
        project fallback) — a dep that lives in a sibling project resolves
        cleanly instead of erroring with "does not exist". A dep id present
        in the global map but NOT in *all_epic_ids* surfaces no error (this
        is the cross-project happy path); a dep id absent from BOTH still
        errors as before. When None, only *all_epic_ids* participates, so
        single-project test fixtures stay bit-identical (fn-600).
    epic_spec_content:
        Optional in-memory epic spec markdown. When provided, the on-disk
        spec-file existence check at ``data_dir/specs/<eid>.md`` is skipped
        — the caller has the content in memory and is asserting it is
        present. Used by scaffold's pre-write integrity gate (fn-623) so
        no spec file lands on disk before integrity passes; the invariant
        "scaffold that fails the integrity gate leaves zero orphaned
        ``specs/fn-N-*.md``" then holds without rollback bookkeeping. When
        None (the default), the on-disk check fires as before — bit-
        identical to pre-fn-623 behavior for ``validate --epic`` and any
        legacy in-memory caller that materialises the spec on disk first.
    """
    from planctl.deps import detect_cycles
    from planctl.ids import epic_id_from_task, is_epic_id, is_task_id
    from planctl.models import (
        APPROVAL_STATUSES,
        EPIC_STATUSES,
        TASK_BACKENDS,
        TASK_STATUSES,
        merge_task_state,
    )
    from planctl.specs import validate_task_spec_headings

    errors: list[str] = []
    warnings: list[str] = []

    # --- Epic meta ---------------------------------------------------------
    for field in ["id", "title", "status"]:
        if field not in epic_data:
            errors.append(f"Epic {eid}: missing required field '{field}'")

    status = epic_data.get("status", "")
    if status not in EPIC_STATUSES:
        errors.append(f"Epic {eid}: invalid status '{status}'")

    # fn-592: approval enum check. Missing/null is the implicit "pending"
    # default (see normalize_epic) and is NOT an error.
    if "approval" in epic_data:
        approval = epic_data["approval"]
        if approval is not None and approval not in APPROVAL_STATUSES:
            errors.append(
                f"Epic {eid}: invalid approval {approval!r} "
                f"(must be null or one of {list(APPROVAL_STATUSES)})"
            )

    # Epic spec presence: on-disk by default; in-memory when the caller passed
    # ``epic_spec_content`` (scaffold's pre-write gate; see param docs).
    if epic_spec_content is None:
        spec_path = data_dir / "specs" / f"{eid}.md"
        if not spec_path.exists():
            errors.append(f"Epic {eid}: spec file missing at specs/{eid}.md")

    # --- Epic-level depends_on_epics --------------------------------------
    # fn-600: cross-project deps resolve via the optional ``all_global_epic_ids``
    # map. A dep id present in the project-local set OR the cross-project
    # global map is "exists"; absent from both is a hard error. When the
    # global map is None (legacy single-repo path / older fixtures), the
    # check falls back to the project-local set only — bit-identical to the
    # pre-fn-600 behavior for callers that don't opt in.
    for dep_eid in epic_data.get("depends_on_epics", []):
        if dep_eid == eid:
            errors.append(f"Epic {eid}: self-referential dependency")
        elif not is_epic_id(dep_eid):
            errors.append(f"Epic {eid}: invalid epic ID in depends_on_epics: {dep_eid}")
        elif dep_eid not in all_epic_ids and (
            all_global_epic_ids is None or dep_eid not in all_global_epic_ids
        ):
            errors.append(f"Epic {eid}: dependency {dep_eid} does not exist")

    # --- Cycle detection across the epic-dep graph ------------------------
    # Mirrors the task-graph cycle check below.  Skipped when the caller
    # didn't pass a project-wide deps map (some legacy fixtures and pre-write
    # callers that don't have every sibling epic loaded).  ``add-deps`` and
    # ``refine-apply`` already run their own pre-write cycle assertion; this
    # is the belt-and-suspenders post-mutation gate that catches a cycle no
    # matter which write path landed it (including direct JSON edits and the
    # ``add-dep`` single-edge verb whose own runner does NOT pre-check).
    if all_epic_deps is not None:
        epic_dep_graph: dict[str, dict] = {}
        for ep_id, ep_deps in all_epic_deps.items():
            epic_dep_graph[ep_id] = {"depends_on": list(ep_deps)}
        # Overlay the post-mutation dep list for the epic under check — the
        # caller may have already merged this into the map, but doing it here
        # guarantees the freshest view even when callers forget.
        epic_dep_graph[eid] = {
            "depends_on": list(epic_data.get("depends_on_epics", []))
        }
        epic_cycle = detect_cycles(epic_dep_graph)
        if epic_cycle:
            cycle_str = " -> ".join(epic_cycle)
            errors.append(f"Epic {eid}: epic-dep cycle detected: {cycle_str}")

    # --- Multi-repo fields ------------------------------------------------
    primary_repo = epic_data.get("primary_repo")
    if primary_repo is not None:
        if check_filesystem_repos:
            err = _validate_repo_path(primary_repo, f"Epic {eid}: primary_repo")
            if err:
                errors.append(err)
            else:
                if not os.path.samefile(primary_repo, data_dir.parent):
                    errors.append(
                        f"Epic {eid}: primary_repo {primary_repo!r} does not match "
                        f"the epic's data directory parent {str(data_dir.parent)!r} — epic is mis-located"
                    )

        touched_repos = epic_data.get("touched_repos")
        if touched_repos is not None and check_filesystem_repos:
            for tr in touched_repos:
                err = _validate_repo_path(tr, f"Epic {eid}: touched_repos entry")
                if err:
                    errors.append(err)

    # --- Per-task checks --------------------------------------------------
    epic_task_ids: set[str] = set(task_defs.keys())
    task_graph: dict[str, dict] = {}

    for tid, task_data in task_defs.items():
        for field in ["id", "epic", "title"]:
            if field not in task_data:
                errors.append(f"Task {tid}: missing required field '{field}'")

        # Status: runtime-aware when state_store provided, otherwise spec-side.
        if state_store is not None:
            runtime = state_store.load_runtime(tid)
            merged = merge_task_state(task_data, runtime)
            task_status = merged.get("status", "todo")
        else:
            task_status = task_data.get("status", "todo")
        if task_status not in TASK_STATUSES:
            errors.append(f"Task {tid}: invalid status '{task_status}'")

        # Task spec validation.
        spec_text = task_spec_contents.get(tid)
        if spec_text is None:
            errors.append(f"Task {tid}: spec file missing at specs/{tid}.md")
        else:
            heading_errors = validate_task_spec_headings(spec_text)
            for he in heading_errors:
                errors.append(f"Task {tid}: {he}")

        # Task dependency shape + cross-epic check.
        for dep_tid in task_data.get("depends_on", []):
            if dep_tid == tid:
                errors.append(f"Task {tid}: self-referential dependency")
            elif not is_task_id(dep_tid):
                errors.append(f"Task {tid}: invalid task ID in depends_on: {dep_tid}")
            else:
                try:
                    dep_epic = epic_id_from_task(dep_tid)
                    if dep_epic != eid:
                        errors.append(
                            f"Task {tid}: dependency {dep_tid} is in different epic {dep_epic}"
                        )
                except ValueError:
                    errors.append(f"Task {tid}: invalid dependency ID: {dep_tid}")

        # fn-592: approval enum check on tasks.
        if "approval" in task_data:
            task_approval = task_data["approval"]
            if task_approval is not None and task_approval not in APPROVAL_STATUSES:
                errors.append(
                    f"Task {tid}: invalid approval {task_approval!r} "
                    f"(must be null or one of {list(APPROVAL_STATUSES)})"
                )

        # preferred_backend allowlist check (fn-586 dormant infra).
        if "preferred_backend" in task_data:
            pb = task_data["preferred_backend"]
            if pb is not None and pb not in TASK_BACKENDS:
                errors.append(
                    f"Task {tid}: invalid preferred_backend {pb!r} "
                    f"(must be null or one of {list(TASK_BACKENDS)})"
                )

        # target_repo validation (new-style tasks only — null skips).
        target_repo = task_data.get("target_repo")
        if target_repo is not None:
            if check_filesystem_repos:
                err = _validate_repo_path(target_repo, f"Task {tid}: target_repo")
                if err:
                    errors.append(err)
            # Warn (not error) if target_repo not in epic.touched_repos —
            # surfaces under either mode since it's a pure-string check.
            touched_repos = epic_data.get("touched_repos")
            if touched_repos is not None:
                resolved_target = str(Path(target_repo).resolve())
                resolved_touched = [str(Path(tr).resolve()) for tr in touched_repos]
                if resolved_target not in resolved_touched:
                    warnings.append(
                        f"Task {tid}: target_repo {target_repo!r} is not in "
                        f"epic.touched_repos — this may indicate a misconfiguration"
                    )

        task_graph[tid] = task_data

    # --- Cross-task dep existence ----------------------------------------
    for tid, tdata in task_graph.items():
        for dep_tid in tdata.get("depends_on", []):
            if dep_tid not in epic_task_ids:
                errors.append(f"Task {tid}: dependency {dep_tid} does not exist")

    # --- Cycle detection across the task graph ---------------------------
    cycle = detect_cycles(task_graph)
    if cycle:
        cycle_str = " -> ".join(cycle)
        errors.append(f"Epic {eid}: dependency cycle detected: {cycle_str}")

    # --- Epic-done coherence (every task must be done) -------------------
    if epic_data.get("status") == "done":
        for tid in epic_task_ids:
            tdata = task_graph.get(tid, {})
            if state_store is not None:
                runtime = state_store.load_runtime(tid)
                merged = merge_task_state(tdata, runtime)
                tstatus = merged.get("status")
            else:
                tstatus = tdata.get("status")
            if tstatus != "done":
                errors.append(
                    f"Epic {eid}: status is 'done' but task {tid} has status '{tstatus}'"
                )

    return errors, warnings


def check_epic_tree_in_memory(
    eid: str,
    epic_data: dict,
    task_defs: dict[str, dict],
    task_spec_contents: dict[str, str],
    *,
    data_dir: Path,
    all_epic_ids: set[str],
    check_filesystem_repos: bool = False,
    all_epic_deps: dict[str, list[str]] | None = None,
    all_global_epic_ids: dict[str, Path] | None = None,
    epic_spec_content: str | None = None,
) -> tuple[list[str], list[str]]:
    """Run the integrity check against a pre-assembled in-memory tree.

    Used by scaffold (and any future caller building a tree without round-
    tripping through disk) so the integrity check fires before any
    ``atomic_write_json`` lands a partial tree.

    ``state_store`` is hardcoded to None — fresh-mint trees carry their own
    spec-side status field (``"open"`` for epics, ``"todo"`` for tasks) and
    no runtime state exists yet.

    ``check_filesystem_repos`` defaults to False on this path because the
    fresh-mint tree may reference repo paths that don't exist as ``.git/``
    dirs on the minting host yet (artbird auto-deploy ships epic JSON
    cross-machine; the worker spawn / ``validate --epic`` job runs the
    filesystem check at the destination).  Set True only when the caller
    knows the resolved paths are local-and-final.

    ``all_epic_deps`` is the same project-wide ``{epic_id: depends_on_epics}``
    map ``_check_epic_tree`` documents — scaffold should pass the in-memory
    sibling-deps view (built from a single glob of ``data_dir/epics``) so an
    epic-dep cycle introduced through a freshly-minted ``depends_on_epics``
    field surfaces before any ``atomic_write_json`` lands the tree.  When
    None, the epic-dep cycle check is skipped.

    ``all_global_epic_ids`` (fn-600) is the cross-project ``{epic_id:
    project_path}`` index — scaffold passes ``scan_epic_ids_global`` output
    so a declared cross-project dep resolves cleanly through the existence
    check.  When None, only the project-local *all_epic_ids* participates
    (single-repo fallback, bit-identical to pre-fn-600 behaviour).

    ``epic_spec_content`` (fn-623) lets the caller assert the epic spec is
    present by passing its in-memory markdown instead of writing a temp
    file to ``data_dir/specs/<eid>.md`` before the check. Scaffold's
    pre-write integrity gate sets this so NO spec file lands on disk
    before integrity passes — closing the orphan-spec leak that advanced
    ``scan_max_epic_id`` on non-clean exits. When None, the on-disk check
    fires as before (bit-identical to pre-fn-623 callers).
    """
    return _check_epic_tree(
        eid,
        epic_data,
        task_defs,
        task_spec_contents,
        data_dir=data_dir,
        all_epic_ids=all_epic_ids,
        state_store=None,
        check_filesystem_repos=check_filesystem_repos,
        all_epic_deps=all_epic_deps,
        all_global_epic_ids=all_global_epic_ids,
        epic_spec_content=epic_spec_content,
    )


def validate_epic_integrity(epic_id: str, data_dir: Path) -> list[str]:
    """Return the list of structural-integrity errors for *epic_id* on disk.

    Empty list ⇔ epic is valid.  This is the public surface used by
    ``run_validate.py:--epic`` and any future caller that needs the same
    check after a write (e.g. refine-apply's post-write re-stamp path).

    Loads the epic JSON, every task JSON belonging to it, and every task spec
    file from *data_dir*, then runs :func:`_check_epic_tree`.  The all-epics
    set (for ``depends_on_epics`` existence) is built from a single glob over
    ``data_dir/epics``.

    Errors-only return — ``validate --epic`` consumes the warnings list
    separately via :func:`validate_epic_integrity_with_warnings` below.  Most
    callers just want the pass/fail bit.
    """
    errors, _warnings = validate_epic_integrity_with_warnings(epic_id, data_dir)
    return errors


def validate_epic_integrity_with_warnings(
    epic_id: str, data_dir: Path
) -> tuple[list[str], list[str]]:
    """Same as :func:`validate_epic_integrity` but returns ``(errors, warnings)``.

    ``validate --epic`` needs both lists for its non-standard
    ``{valid, errors, warnings}`` envelope shape.  The bare
    :func:`validate_epic_integrity` is the simpler surface for callers that
    only branch on pass/fail.
    """
    from planctl.project import resolve_project
    from planctl.store import LocalFileStateStore, load_json_safe

    epic_path = data_dir / "epics" / f"{epic_id}.json"
    epic_data = load_json_safe(epic_path)
    if epic_data is None:
        return (
            [f"Epic {epic_id}: definition file is missing or invalid JSON"],
            [],
        )

    # Build the all-epics set for depends_on_epics existence checks plus the
    # ``{epic_id: depends_on_epics}`` map used for cycle detection on the
    # project-wide epic-dep graph.  Single glob covers both — the JSON loads
    # are cheap (one read per epic, no spec files touched here).
    epics_dir = data_dir / "epics"
    all_epic_ids: set[str] = set()
    all_epic_deps: dict[str, list[str]] = {}
    if epics_dir.exists():
        for f in epics_dir.glob("*.json"):
            all_epic_ids.add(f.stem)
            ep = load_json_safe(f)
            if ep is None:
                # A corrupt epic JSON can't contribute deps; existence is
                # still captured via the stem above so add-dep / scaffold
                # existence checks behave the same.
                continue
            all_epic_deps[f.stem] = list(ep.get("depends_on_epics", []))
    # Ensure the epic under check is represented with its current on-disk deps
    # (the glob above already covers it, but the explicit overlay matches the
    # in-memory caller pattern and guards against a stale missing-from-disk
    # edge case).
    all_epic_deps[epic_id] = list(epic_data.get("depends_on_epics", []))

    # fn-600: extend the existence + cycle universe across every discovered
    # project so a cross-project dep resolves cleanly (existence check) and
    # a cross-project A -> B -> A cycle surfaces here (cycle check). Fail-
    # soft on discovery: an unconfigured / empty ``roots`` yields an empty
    # global map, which keeps single-project workflows bit-identical (the
    # local glob above is still the source of truth in that degraded case).
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
    errors: list[str] = []

    tasks_dir = data_dir / "tasks"
    if tasks_dir.exists():
        for tf in tasks_dir.glob(f"{epic_id}.*.json"):
            task_data = load_json_safe(tf)
            if task_data is None:
                errors.append(f"Task {tf.stem}: definition file is invalid JSON")
                continue
            tid = task_data.get("id", tf.stem)
            task_defs[tid] = task_data

            task_spec_path = data_dir / "specs" / f"{tid}.md"
            if task_spec_path.exists():
                task_spec_contents[tid] = task_spec_path.read_text(encoding="utf-8")
            else:
                task_spec_contents[tid] = None

    # Resolve project state-store for runtime-aware task status checks.
    try:
        ctx = resolve_project()
        state_store: LocalFileStateStore | None = LocalFileStateStore(ctx.state_dir)
    except Exception:  # pragma: no cover — resolve_project rarely fails post-init
        state_store = None

    core_errors, core_warnings = _check_epic_tree(
        epic_id,
        epic_data,
        task_defs,
        task_spec_contents,
        data_dir=data_dir,
        all_epic_ids=all_epic_ids,
        state_store=state_store,
        all_epic_deps=all_epic_deps,
        all_global_epic_ids=all_global_epic_ids,
    )
    return errors + core_errors, core_warnings


__all__ = (
    "_validate_repo_path",
    "check_epic_tree_in_memory",
    "validate_epic_integrity",
    "validate_epic_integrity_with_warnings",
)
