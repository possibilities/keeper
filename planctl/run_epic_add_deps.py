"""planctl epic add-deps - Batch-wire N epic-level dependency edges (fn-565).

The batch equivalent of ``epic add-dep``. Wires multiple ``epic -> dep`` edges in
one call so ``/plan:plan`` Phase 7 (and the R5b additive replay) can collapse the
per-edge loop into a single invocation.

Execution order is **assert-all → mutate → emit**, collecting ALL per-edge
errors in one pass (scaffold-style ``details:[]``).

Idempotency: an edge that is already wired returns ``ALREADY_PRESENT`` (a no-op,
NOT an error — mirrors ``claim``'s ``ALREADY_MINE``), so the refine path's
additive replay stays safe re-running on already-wired edges.

Failure shape (any per-edge error): emits a structured
``{success:false, error:{code, message, details:[<per-entry>]}}`` envelope on
stdout, exits non-zero, and writes NOTHING. Codes (stable priority order
``bad_id`` → ``dep_ambiguous_id`` → ``epic_not_found`` → ``dep_done`` →
``dep_cycle``):

- ``bad_id`` — a dep id is malformed (fails ``is_epic_id``) or self-referential
- ``dep_ambiguous_id`` (fn-600) — a dep id resolves to two or more projects
  (legacy dup state). Details list every owning project path.
- ``epic_not_found`` — the target epic, or a dep epic, does not exist on disk
  in any discovered project
- ``dep_done`` — a dep epic is ``done`` (cannot depend on a closed epic)
- ``dep_cycle`` — wiring the edges would introduce a cycle in the epic-dep graph

On success, emits ONE ``planctl_invocation`` envelope. Per-edge outcomes are
reported as ``results: [{dep_id, status}]`` where ``status`` is ``WIRED`` or
``ALREADY_PRESENT``; the final ``depends_on_epics`` list is also returned.
"""

from __future__ import annotations

import json
import sys
from types import SimpleNamespace
from typing import NoReturn


def _emit_failure(code: str, message: str, details: list[str]) -> NoReturn:
    """Emit a structured failure envelope and exit non-zero (writes nothing).

    Bypasses ``output.emit_error`` (which hard-fails on the first error) so this
    batch verb can accumulate ALL per-edge errors into one envelope. Compact
    single-line JSON matches the scaffold/refine-apply failure shape.

    Raises ``SystemExit(1)`` rather than returning the code: this verb lives
    under the ``epic`` subgroup, and a plain ``return 1`` from a nested-group
    leaf is swallowed by the group invoke chain (exit stays 0). ``sys.exit``
    propagates the non-zero code regardless of group nesting (mirrors the
    single-edge ``add-dep``'s ``emit_error`` raise).
    """
    envelope = {
        "success": False,
        "error": {
            "code": code,
            "message": message,
            "details": details,
        },
    }
    print(json.dumps(envelope, separators=(",", ":")), flush=True)
    sys.exit(1)


def _render_human(data: dict) -> str:
    epic_id = data.get("epic_id")
    results = data.get("results", [])
    wired = [r["dep_id"] for r in results if r["status"] == "WIRED"]
    present = [r["dep_id"] for r in results if r["status"] == "ALREADY_PRESENT"]
    skipped = [r for r in results if str(r["status"]).startswith("SKIPPED_")]
    parts = [f"Epic deps for {epic_id}:"]
    parts.append(f"wired {', '.join(wired) or '(none)'}")
    if present:
        parts.append(f"already present {', '.join(present)}")
    if skipped:
        skip_str = ", ".join(f"{r['dep_id']}({r['status']})" for r in skipped)
        parts.append(f"skipped {skip_str}")
    return " ".join(parts)


def run(args: SimpleNamespace) -> int:
    from planctl.deps import detect_cycles
    from planctl.discovery import resolve_epic_globally
    from planctl.ids import is_epic_id
    from planctl.output import emit
    from planctl.project import resolve_project
    from planctl.store import atomic_write_json, load_json, now_iso

    epic_id: str = args.epic_id
    dep_ids: list[str] = list(args.dep_ids)
    skip_invalid: bool = bool(getattr(args, "skip_invalid", False))

    ctx = resolve_project()
    data_dir = ctx.data_dir
    epics_dir = data_dir / "epics"
    epic_path = epics_dir / f"{epic_id}.json"

    # ------------------------------------------------------------------
    # Assert-all: id shape, existence (cwd-then-global), self-ref, ambiguous,
    # done-target — collect every per-edge error before any mutation.
    # ------------------------------------------------------------------
    bad_id_errors: list[str] = []
    ambiguous_errors: list[str] = []
    not_found_errors: list[str] = []
    done_errors: list[str] = []
    # fn-589 task .1 (item 9): when --skip-invalid is set, per-edge classifier
    # errors route into the per-edge results array as SKIPPED_* statuses
    # instead of short-circuiting the call.  Keyed by dep_id; values are one
    # of "SKIPPED_BAD_ID" / "SKIPPED_NOT_FOUND" / "SKIPPED_AMBIGUOUS" /
    # "SKIPPED_DONE".  The target-epic-not-found case still fails loud — no
    # place to wire any edge if the parent doesn't exist.
    skipped_by_id: dict[str, str] = {}
    # fn-20: normalize a number-only ``fn-N`` input to the resolved FULL slug
    # id so the persisted ``depends_on_epics`` edge stays canonical (the
    # readiness gate keys by full id). Keyed by the raw input dep_id; a slug
    # input maps to itself.
    normalized_by_id: dict[str, str] = {}

    if not epic_path.exists():
        not_found_errors.append(f"epic not found: {epic_id}")

    seen: set[str] = set()
    for dep_id in dep_ids:
        if dep_id in seen:
            continue
        seen.add(dep_id)
        if not is_epic_id(dep_id):
            if skip_invalid:
                skipped_by_id[dep_id] = "SKIPPED_BAD_ID"
                continue
            bad_id_errors.append(f"dep id {dep_id!r} is not a valid epic id")
            continue
        if dep_id == epic_id:
            if skip_invalid:
                skipped_by_id[dep_id] = "SKIPPED_BAD_ID"
                continue
            bad_id_errors.append(f"epic cannot depend on itself: {dep_id}")
            continue
        # fn-600: resolve cwd-then-global so cross-project deps wire.
        # Ambiguous (legacy dup) is a distinct error class from not-found.
        dep_resolution = resolve_epic_globally(dep_id)
        if dep_resolution.ambiguous:
            if skip_invalid:
                skipped_by_id[dep_id] = "SKIPPED_AMBIGUOUS"
                continue
            owners = ", ".join(str(p) for p in dep_resolution.owners)
            ambiguous_errors.append(
                f"dep epic {dep_id} exists in multiple projects: {owners}"
            )
            continue
        if not dep_resolution.resolved:
            if skip_invalid:
                skipped_by_id[dep_id] = "SKIPPED_NOT_FOUND"
                continue
            not_found_errors.append(f"dep epic not found: {dep_id}")
            continue
        assert dep_resolution.epic_path is not None
        assert dep_resolution.resolved_id is not None
        normalized_by_id[dep_id] = dep_resolution.resolved_id
        dep_def = load_json(dep_resolution.epic_path)
        if dep_def.get("status") == "done":
            if skip_invalid:
                skipped_by_id[dep_id] = "SKIPPED_DONE"
                continue
            done_errors.append(f"dep epic is done (cannot depend on it): {dep_id}")

    # Stable priority order so a single envelope surfaces the dominant class;
    # other-class errors still appear in details.  fn-600: ``dep_ambiguous_id``
    # slots in between ``bad_id`` and ``epic_not_found`` — a malformed id is
    # the most basic shape failure, ambiguity is a graph-level error class
    # (the id exists, but the resolver refuses to silently pick a winner),
    # and not-found is the weakest classifier (the id exists nowhere).
    # ``dep_done`` stays last among classifier errors because it requires the
    # dep to already resolve uniquely.  With --skip-invalid the only remaining
    # failure here is the target epic itself not existing — there is no place
    # to wire any edge at all in that case.
    if bad_id_errors:
        return _emit_failure(
            "bad_id",
            "One or more dep ids are malformed or self-referential",
            bad_id_errors + ambiguous_errors + not_found_errors + done_errors,
        )
    if ambiguous_errors:
        return _emit_failure(
            "dep_ambiguous_id",
            "One or more dep ids resolve to multiple projects",
            ambiguous_errors + not_found_errors + done_errors,
        )
    if not_found_errors:
        return _emit_failure(
            "epic_not_found",
            "One or more epics do not exist",
            not_found_errors + done_errors,
        )
    if done_errors:
        return _emit_failure(
            "dep_done",
            "One or more dep epics are done",
            done_errors,
        )

    # ------------------------------------------------------------------
    # Compute the post-wire dep list (idempotent: dup → ALREADY_PRESENT, no-op).
    # Walk dep_ids in original order so the results array reflects the call
    # ordering, splicing in any SKIPPED_* entries the assert-all loop diverted
    # (fn-589 task .1, item 9).
    # ------------------------------------------------------------------
    epic_def = load_json(epic_path)
    deps: list[str] = list(epic_def.get("depends_on_epics", []))

    results: list[dict] = []
    new_edges = 0
    results_seen: set[str] = set()
    for dep_id in dep_ids:
        if dep_id in results_seen:
            continue
        results_seen.add(dep_id)
        if dep_id in skipped_by_id:
            results.append({"dep_id": dep_id, "status": skipped_by_id[dep_id]})
            continue
        # fn-20: persist + dedup against the FULL slug id (a number-only input
        # normalizes here), so the on-disk edge is canonical and an already-
        # wired slug edge is recognized when re-supplied as a bare number.
        full_id = normalized_by_id.get(dep_id, dep_id)
        if full_id in deps:
            results.append({"dep_id": full_id, "status": "ALREADY_PRESENT"})
            continue
        deps.append(full_id)
        new_edges += 1
        results.append({"dep_id": full_id, "status": "WIRED"})

    # ------------------------------------------------------------------
    # Cycle detection on the post-wire epic-dep graph. fn-600: walks every
    # discovered project's epics so a cross-project A -> B -> A cycle
    # surfaces here, not just same-project cycles. Build the graph from every
    # epic's current depends_on_epics, then overlay the target epic's new dep
    # list. detect_cycles expects {"depends_on": [...]} per node. Same-id
    # collisions across projects (legacy dup state) merge into the last-walked
    # node; the dep_ambiguous_id gate above already rejects edges that would
    # reach an ambiguous owner, so this is benign in practice.
    # ------------------------------------------------------------------
    if new_edges:
        from planctl.discovery import discover_projects

        graph: dict[str, dict] = {}
        # fn-601: guard discover_projects() — mirrors integrity.py:479-482 and
        # validation_restamp.py:153-156. If discovery raises (misconfigured
        # roots, permission error), degrade to "no global projects" so the
        # local backstop walk below still runs and add-dep completes.
        try:
            discovered = discover_projects()
        except Exception:
            discovered = []
        for project in discovered:
            project_epics = project / ".planctl" / "epics"
            if not project_epics.exists():
                continue
            for ep_file in project_epics.glob("*.json"):
                ep = load_json(ep_file)
                graph[ep["id"]] = {"depends_on": list(ep.get("depends_on_epics", []))}
        # Local project's epics may not have been picked up by discovery (e.g.
        # cwd is not under a configured root). Walk locally too as a backstop.
        for ep_file in epics_dir.glob("*.json"):
            ep = load_json(ep_file)
            graph.setdefault(
                ep["id"],
                {"depends_on": list(ep.get("depends_on_epics", []))},
            )
        graph[epic_id] = {"depends_on": deps}
        cycle = detect_cycles(graph)
        if cycle:
            return _emit_failure(
                "dep_cycle",
                "Wiring these edges would introduce a cycle in the epic-dep graph",
                [f"cycle: {' -> '.join(cycle)}"],
            )

    # ------------------------------------------------------------------
    # Mutate: write once iff at least one new edge landed. A pure all-no-op
    # call (every edge ALREADY_PRESENT) writes nothing — keeps the additive
    # replay path from churning updated_at / clearing the marker needlessly.
    # ------------------------------------------------------------------
    if new_edges:
        epic_def["depends_on_epics"] = deps
        epic_def["updated_at"] = now_iso()
        atomic_write_json(epic_path, epic_def)

        # fn-587 task .4: re-stamp last_validated_at after the structural
        # write.  add-deps has already run its own pre-write assert-all
        # (id-shape / existence / done-target / cycle), so the post-write
        # integrity check here is the belt-and-suspenders pattern shared with
        # the single-edge add-dep verb.  fn-588 task .1: the shared helper
        # now walks the project-wide epic-dep graph for cycles, so the
        # post-write gate has its own cycle detection (independent of the
        # pre-write assert above) and a cycle landed by any other path would
        # also surface here.
        from planctl.validation_restamp import restamp_epic_or_fail

        new_stamp = restamp_epic_or_fail(epic_id, data_dir, verb="add-deps")
        epic_def = load_json(epic_path)
        epic_def["last_validated_at"] = new_stamp
        atomic_write_json(epic_path, epic_def)

    # fn-629 task .3: route through the central seam. Rewrite of a
    # pre-existing tracked file (atomic_write rename-atomic) → no unwind.
    # The pure-no-op call (every edge ALREADY_PRESENT, ``new_edges == 0``)
    # still routes through the seam; ``auto_commit_from_invocation`` no-ops
    # on the empty dirty-set.
    emit(
        {
            "epic_id": epic_id,
            "depends_on_epics": deps,
            "results": results,
        },
        text_renderer=_render_human,
        verb="add-deps",
        target=epic_id,
        repo_root=ctx.project_path,
    )
    return 0
