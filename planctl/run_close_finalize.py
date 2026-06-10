"""planctl close-finalize - encode the close saga in Python from observable state.

The fn-12 crush rebuilds ``/plan:close`` as a content-blind coordinator.
``close-finalize <epic_id>`` is the saga step: it derives its position purely
from observable state (the persisted audit artifacts + the epic's own status) —
there is NO saga-state file. It runs every reversible check FIRST and performs
the irreversible ``epic close`` mutation LAST, so a crash mid-saga always leaves
the source epic OPEN and the verb re-runnable.

Saga order (the load-bearing artifact, pinned by the truth-table tests):

1. Resolve project + load the epic. If the epic is ALREADY ``done`` → return the
   prior terminal outcome idempotently (a follow-up wired + complete →
   ``closed_with_followup``; else → ``closed_clean``). ``epic close`` is NEVER
   called twice — ``run_epic_close``'s "already done" error path is never hit.
2. Re-derive ``commit_set_hash`` FRESH via ``find_commit_groups`` +
   ``compute_commit_set_hash``. A mismatch against the persisted verdict's
   stamped hash → typed ``STALE_ARTIFACTS`` (a commit landed after the audit;
   refuse, never delete — a ``/plan:close`` re-run overwrites the artifacts).
3. Read ``verdict.json``: missing → typed ``VERDICT_MISSING``;
   ``fatal: true`` → outcome ``fatal_halt`` (no close; the epic stays open).
4. Zero surviving decisions (every finding culled, or no decisions at all) →
   ``planctl epic close`` → ``closed_clean``.
5. Else the kept/merged findings need a follow-up epic. The completeness
   invariant the old skill held caller-side moves IN-PROCESS here:
   ``expected`` = the distinct non-null kept/merged ordinals in the verdict.
   - A follow-up already wired (open epic depending on the source) AND
     ``actual_tasks == expected`` → adopt it, SKIP scaffold (crash-resume path).
   - Wired but ``actual_tasks < expected`` (a crashed mid-scaffold run) →
     typed ``partial_followup`` outcome (stop for the human; no scaffold, no
     close).
   - Absent → scaffold from the persisted ``followup.yaml`` via the REAL
     scaffold mint (a missing ``followup.yaml`` with surviving decisions is a
     typed ``FOLLOWUP_MISSING`` fail-closed error), then ``epic close`` →
     ``closed_with_followup`` carrying the new epic id.

Outcomes are a :class:`CloseOutcome` ``(str, Enum)`` — ``closed_clean`` /
``closed_with_followup`` / ``fatal_halt`` / ``partial_followup``. Every member
MUST have a skill handler; the exhaustiveness test in
``tests/test_close_finalize.py`` is the standing guard (the reconcile-verdict
exhaustiveness test is the template).

Read-then-mutate: the verb is conditionally mutating. On ``fatal_halt`` /
``partial_followup`` / a typed refusal it mutates nothing and emits a read-only
envelope. On a real close it delegates to ``run_epic_close`` (which owns the
``epic close`` ``.planctl/`` commit) and to the real ``scaffold`` mint (which
owns the follow-up tree's commit) — finalize itself never writes ``.planctl/``
or draws its own commit; it orchestrates the two mutating verbs and reports the
typed outcome.

Typed errors (no mutation; exit 1): ``BAD_EPIC_ID``, ``NOT_A_PROJECT``,
``EPIC_NOT_FOUND``, ``STALE_ARTIFACTS``, ``VERDICT_MISSING``,
``VERDICT_CORRUPT``, ``FOLLOWUP_MISSING``, ``SCAFFOLD_FAILED``.
"""

from __future__ import annotations

import io
import json
import sys
from contextlib import redirect_stdout
from enum import Enum
from pathlib import Path
from types import SimpleNamespace
from typing import Any, NoReturn, cast


class CloseOutcome(str, Enum):
    """The four terminal outcomes the close coordinator switches on.

    ``str, Enum`` (not ``StrEnum``) so ``.value`` serializes to a plain JSON
    string on every supported interpreter and ``==`` against a bare literal
    works in tests. Every member here MUST have a ``/plan:close`` skill handler —
    the exhaustiveness test in ``tests/test_close_finalize.py`` asserts it.
    """

    CLOSED_CLEAN = "closed_clean"
    CLOSED_WITH_FOLLOWUP = "closed_with_followup"
    FATAL_HALT = "fatal_halt"
    PARTIAL_FOLLOWUP = "partial_followup"


def _emit_finalize_error(
    code: str, message: str, *, details: dict[str, Any] | None = None
) -> NoReturn:
    """Emit a typed close-finalize error envelope and exit 1.

    Shape ``{"success": false, "error": {"code", "message", "details?"}}`` — the
    house single-fetch error shape (claim / close-preflight / reconcile). Routes
    through ``format_output`` so ``--format yaml`` renders YAML. No
    ``planctl_invocation`` line; sets the invocation sentinel so the decorator
    never double-emits after this terminal envelope.
    """
    from planctl._util import format_output

    error: dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        error["details"] = details
    format_output({"success": False, "error": error})
    _set_invocation_sentinel()
    sys.exit(1)


def _set_invocation_sentinel() -> None:
    """Suppress the decorator's trailing readonly envelope on the failure path.

    Mirrors ``run_reconcile._set_invocation_sentinel``. No-op when there is no
    active click context (tests calling ``run()`` directly).
    """
    try:
        import click

        from planctl.output import INVOCATION_EMITTED_SENTINEL

        cctx = click.get_current_context()
        if cctx.obj is None:
            cctx.obj = {}
        if isinstance(cctx.obj, dict):
            cctx.obj[INVOCATION_EMITTED_SENTINEL] = True
    except RuntimeError:
        pass


def _context_for_root(project_root: Path):
    """Build a ProjectContext from a project root dir (the ``.planctl/`` parent).

    Mirrors ``run_reconcile._context_for_root`` / ``run_close_preflight._context_for_root``.
    """
    from planctl.project import ProjectContext

    planctl_dir = project_root / ".planctl"
    return ProjectContext(
        name=project_root.name,
        data_dir=planctl_dir,
        state_dir=planctl_dir / "state",
        project_path=project_root,
    )


def _resolve_project(project: str | None):
    """Resolve the owning project for *epic_id* (``--project`` or cwd-walk).

    Mirrors ``run_close_preflight``'s resolution: ``--project`` is an absolute
    path bypass (relative → UsageError, no ``.planctl/`` → ``NOT_A_PROJECT``);
    unset falls back to ``resolve_project()``'s cwd-walk.
    """
    import click

    from planctl.project import resolve_project

    if project is not None:
        project_path_obj = Path(project).expanduser()
        if not project_path_obj.is_absolute():
            raise click.UsageError(
                f"--project requires an absolute path, got: {project}"
            )
        project_root = project_path_obj.resolve()
        if not (project_root / ".planctl").is_dir():
            _emit_finalize_error(
                "NOT_A_PROJECT",
                f"No planctl project found at {project_root}. Run 'planctl init' first.",
            )
        return _context_for_root(project_root)
    return resolve_project()


def _expected_cluster_ordinals(verdict: dict) -> set[int]:
    """Distinct non-null kept/merged ordinals in the persisted verdict.

    A ``culled`` decision carries ``task: null`` (spawns no follow-up); ``kept``
    and ``merged-into-*`` carry an integer ordinal. Multiple findings can merge
    into the same ordinal, so the DISTINCT ordinals are the follow-up tasks the
    plan provisions. Mirrors ``run_followup_submit._expected_cluster_count`` (set
    here so the completeness comparison can use the count AND the membership).
    """
    return {
        d["task"]
        for d in verdict.get("decisions", [])
        if isinstance(d.get("task"), int) and not isinstance(d.get("task"), bool)
    }


def _find_followup_epic(data_dir: Path, source_epic_id: str) -> dict | None:
    """Return the open epic the close saga itself scaffolded for *source_epic_id*.

    Discovery rides positive provenance: the matching epic is the one whose
    ``created_by_close_of`` stamp equals *source_epic_id* — written into the
    minted follow-up JSON by the saga's own scaffold step. ``depends_on_epics``
    membership is never consulted, so a human-planned epic that legitimately
    depends on the source is invisible here; absence of the stamp means "not
    mine" with no heuristic fallback. The stamp is immutable after mint.

    First-seen wins via ``sorted(glob())`` (alphabetic filename order,
    deterministic across filesystems). Returns ``{"epic_id", "actual_tasks",
    "depends_on_epics", "status"}`` for the hit, or ``None`` when no open epic
    carries the stamp. ``actual_tasks`` is the count of task JSONs on disk for
    the follow-up; ``depends_on_epics`` is incidental (carried for callers, not
    a match input). The raw ``load_json_safe`` read does no type coercion, so a
    malformed stamp safely fails equality and is skipped.
    """
    from planctl.store import load_json_safe

    epics_dir = data_dir / "epics"
    tasks_dir = data_dir / "tasks"
    if not epics_dir.exists():
        return None

    for ep_file in sorted(epics_dir.glob("*.json")):
        if ep_file.stem == source_epic_id:
            continue
        ep_def = load_json_safe(ep_file)
        if ep_def is None:
            continue
        if ep_def.get("status") != "open":
            continue
        if ep_def.get("created_by_close_of") != source_epic_id:
            continue

        depends_on_epics = list(ep_def.get("depends_on_epics", []))
        candidate_id = ep_def.get("id", ep_file.stem)
        actual_tasks = 0
        if tasks_dir.exists():
            actual_tasks = sum(1 for _ in tasks_dir.glob(f"{candidate_id}.*.json"))
        return {
            "epic_id": candidate_id,
            "actual_tasks": actual_tasks,
            "depends_on_epics": depends_on_epics,
            "status": ep_def.get("status"),
        }
    return None


def _close_epic(ctx, epic_id: str) -> None:
    """Run the real ``epic close`` against *epic_id* (delegates the commit).

    ``run_epic_close`` resolves the project from cwd, so we run it with cwd set
    to the resolved project path and capture its stdout (finalize emits its OWN
    terminal envelope — the close verb's envelope is internal plumbing here).
    ``epic close`` owns the ``chore(planctl): close <epic>`` ``.planctl/`` commit
    via its ``emit()`` auto-commit; finalize draws no commit of its own.

    Status-check-first guarantees this is reached ONLY when the epic is still
    open, so ``run_epic_close``'s "already done" error path is never triggered.
    """
    import os

    from planctl.run_epic_close import run as run_epic_close

    prev_cwd = os.getcwd()
    buf = io.StringIO()
    try:
        os.chdir(ctx.project_path)
        with redirect_stdout(buf):
            run_epic_close(SimpleNamespace(epic_id=epic_id, force=False, reason=None))
    finally:
        os.chdir(prev_cwd)


def _synthesize_verdict_if_zero_findings(
    vp: Path, primary_repo: str, epic_id: str
) -> dict:
    """Return a synthetic empty verdict when the audit found 0 findings.

    When the auditor reports 0 findings the close-planner is intentionally
    skipped, so no verdict.json is written. Synthesize an in-memory empty
    verdict from the report.meta.json sidecar — it carries commit_set_hash
    (the staleness check needs it) plus the findings count (the ``==0`` guard
    is the safety: a non-zero-findings audit with no verdict means the planner
    crashed, not that it was skipped, so the ``>0`` branch still fails closed).

    Fails with VERDICT_MISSING when there is no report.meta.json (audit never
    ran) or when meta.findings > 0 (planner should have run but didn't).
    """
    from planctl.audit_artifacts import report_meta_path

    mp = report_meta_path(primary_repo, epic_id)
    if not mp.exists():
        _emit_finalize_error(
            "VERDICT_MISSING",
            f"no verdict for {epic_id} at {vp}; run `planctl verdict submit` "
            "(via /plan:close) before close-finalize",
            details={"expected": str(vp)},
        )
    try:
        meta = json.loads(mp.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        _emit_finalize_error(
            "VERDICT_MISSING",
            f"no verdict for {epic_id} at {vp}; report.meta.json unreadable: {exc}",
            details={"expected": str(vp)},
        )
    audit_findings: int = meta.get("findings", -1)
    if audit_findings != 0:
        _emit_finalize_error(
            "VERDICT_MISSING",
            f"no verdict for {epic_id} at {vp}; audit reported {audit_findings} "
            "finding(s) but no verdict was submitted — run `planctl verdict submit` "
            "(via /plan:close) before close-finalize",
            details={"expected": str(vp), "audit_findings": audit_findings},
        )
    return {
        "fatal": False,
        "fatal_reason": "",
        "decisions": [],
        "commit_set_hash": meta.get("commit_set_hash"),
    }


def _scaffold_followup(ctx, followup_yaml_path: Path, source_epic_id: str) -> str:
    """Mint the follow-up tree via the REAL scaffold, returning the new epic id.

    Calls ``run_scaffold.run`` in-process with cwd set to the project path
    (scaffold resolves the project cwd-first) and captures its stdout to parse
    the minted ``epic_id`` from the success envelope. The mint gate applies — the
    harness supplies ``CLAUDE_CODE_SESSION_ID``; a missing one makes scaffold
    refuse with ``missing_session_id`` BEFORE any write, surfaced here as
    ``SCAFFOLD_FAILED``. Scaffold owns its own ``.planctl/`` commit via
    ``emit()``; finalize never commits the follow-up tree itself.

    fn-15: the SimpleNamespace carries ``created_by_close_of=source_epic_id``,
    the internal-only provenance arg scaffold reads via ``getattr``. The minted
    follow-up epic JSON therefore stamps ``created_by_close_of: <source>`` in the
    same atomic write as the rest of the epic — the positive signal
    ``_find_followup_epic`` discovers on. No CLI flag, no followup.yaml key.

    A non-zero scaffold exit (any dry-run / mint failure code) surfaces as a
    typed ``SCAFFOLD_FAILED`` carrying scaffold's own error envelope — finalize
    mutated nothing of its own, the source epic is still open, and a re-run is
    safe (the next pass takes the adopt-or-rescaffold path).
    """
    import os

    from planctl.run_scaffold import run as run_scaffold

    prev_cwd = os.getcwd()
    buf = io.StringIO()
    try:
        os.chdir(ctx.project_path)
        with redirect_stdout(buf):
            rc = run_scaffold(
                SimpleNamespace(
                    file=str(followup_yaml_path),
                    allow_duplicate=False,
                    created_by_close_of=source_epic_id,
                )
            )
    finally:
        os.chdir(prev_cwd)

    output = buf.getvalue()
    if rc:
        _emit_finalize_error(
            "SCAFFOLD_FAILED",
            "scaffold of the follow-up plan failed; the source epic is still "
            "open and the close is re-runnable once the plan is fixed",
            details={"scaffold_output": output.strip()},
        )

    new_epic_id = _parse_scaffold_epic_id(output)
    if new_epic_id is None:
        _emit_finalize_error(
            "SCAFFOLD_FAILED",
            "scaffold returned success but no epic_id could be parsed from its "
            "envelope; refusing to close without a follow-up handle",
            details={"scaffold_output": output.strip()},
        )
    return new_epic_id


def _parse_scaffold_epic_id(output: str) -> str | None:
    """Pull ``epic_id`` from scaffold's success envelope on stdout.

    Scaffold emits a JSON envelope carrying a top-level ``epic_id`` plus a
    trailing ``planctl_invocation`` line. Scan every JSON object on stdout for
    the first one carrying an ``epic_id`` (the success payload), skipping the
    invocation line.
    """
    decoder = json.JSONDecoder()
    idx = 0
    while idx < len(output):
        brace = output.find("{", idx)
        if brace == -1:
            break
        try:
            obj, end = decoder.raw_decode(output, brace)
        except json.JSONDecodeError:
            idx = brace + 1
            continue
        if isinstance(obj, dict) and isinstance(obj.get("epic_id"), str):
            return obj["epic_id"]
        idx = end
    return None


def run(args: SimpleNamespace) -> int:  # noqa: PLR0911, PLR0912 — single saga flow
    from planctl.api import load_epic, load_tasks_for_epic, task_sort_key
    from planctl.audit_artifacts import (
        compute_commit_set_hash,
        followup_path,
        verdict_path,
    )
    from planctl.commit_lookup import AllReposBrokenError, find_commit_groups
    from planctl.ids import is_epic_id, is_task_id

    epic_id: str = args.epic_id
    project: str | None = getattr(args, "project", None)

    # 1. validate id (epic-shape; a task-shaped id names its parent epic).
    if not is_epic_id(epic_id):
        if is_task_id(epic_id):
            parent = epic_id.rsplit(".", 1)[0]
            _emit_finalize_error(
                "BAD_EPIC_ID",
                f"close operates on epics, not tasks — parent epic is {parent}",
                details={"task_id": epic_id, "parent_epic": parent},
            )
        _emit_finalize_error("BAD_EPIC_ID", f"Invalid epic ID: {epic_id}")

    # 2. resolve project + load the epic.
    ctx = _resolve_project(project)
    epic_path = ctx.data_dir / "epics" / f"{epic_id}.json"
    if not epic_path.exists():
        _emit_finalize_error(
            "EPIC_NOT_FOUND",
            f"Epic not found in {ctx.project_path}: {epic_id}",
        )
    epic_def = load_epic(ctx, epic_id)
    primary_repo = str(Path(epic_def.get("primary_repo") or ctx.project_path).resolve())
    touched_repos = epic_def.get("touched_repos")

    # 3. idempotent re-run: an already-done epic returns its prior terminal
    #    outcome WITHOUT calling close again. A follow-up wired to this source →
    #    closed_with_followup; else closed_clean. (run_epic_close's "already
    #    done" error path is never reached because we never re-close.)
    if epic_def.get("status") == "done":
        prior_followup = _find_followup_epic(ctx.data_dir, epic_id)
        if prior_followup is not None:
            return _emit_outcome(
                CloseOutcome.CLOSED_WITH_FOLLOWUP,
                epic_id,
                ctx,
                new_epic_id=prior_followup["epic_id"],
            )
        return _emit_outcome(CloseOutcome.CLOSED_CLEAN, epic_id, ctx)

    # 4. read the persisted verdict — the saga cannot proceed without it.
    #    When the audit found 0 findings the close-planner was intentionally
    #    skipped; _synthesize_verdict_if_zero_findings derives an empty verdict
    #    from report.meta.json (findings==0 guard keeps it safe: a >0-findings
    #    audit with no verdict means the planner crashed → still fails closed).
    vp = verdict_path(primary_repo, epic_id)
    if not vp.exists():
        verdict = _synthesize_verdict_if_zero_findings(vp, primary_repo, epic_id)
    else:
        try:
            verdict = json.loads(vp.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            _emit_finalize_error("VERDICT_CORRUPT", f"could not read verdict {vp}: {exc}")

    # 5. re-derive commit_set_hash FRESH; mismatch vs the verdict's stamp →
    #    STALE_ARTIFACTS (a commit landed after the audit). Refuse, never delete.
    task_ids: list[str] = [
        cast(str, t.get("id"))
        for t in sorted(
            load_tasks_for_epic(ctx, epic_id),
            key=lambda t: task_sort_key(t.get("id", "")),
        )
        if t.get("id")
    ]
    try:
        commit_groups = find_commit_groups(task_ids, primary_repo, touched_repos)
    except AllReposBrokenError as exc:
        _emit_finalize_error(
            "COMMIT_LOOKUP_FAILED",
            "commit-trailer scan found no usable repo: every repo in the scan "
            "set is missing or not a git repo",
            details={"broken_repos": exc.broken_repos},
        )
    fresh_hash = compute_commit_set_hash(commit_groups)
    stamped_hash = verdict.get("commit_set_hash")
    if stamped_hash != fresh_hash:
        _emit_finalize_error(
            "STALE_ARTIFACTS",
            f"commit_set_hash drift for {epic_id}: a source commit landed after "
            "the audit ran. Re-run /plan:close to re-audit against the current "
            "commit set (the verb refuses, never deletes, the stale artifacts).",
            details={"stamped_hash": stamped_hash, "fresh_hash": fresh_hash},
        )

    # 6. fatal verdict → halt. No close, no scaffold; the epic stays open.
    if verdict.get("fatal") is True:
        return _emit_outcome(
            CloseOutcome.FATAL_HALT,
            epic_id,
            ctx,
            fatal_reason=verdict.get("fatal_reason", ""),
        )

    # 7. zero surviving decisions (every finding culled or none at all) → clean
    #    close. Surviving = a kept/merged decision with a non-null ordinal.
    expected = _expected_cluster_ordinals(verdict)
    if not expected:
        _close_epic(ctx, epic_id)
        return _emit_outcome(CloseOutcome.CLOSED_CLEAN, epic_id, ctx)

    # 8. surviving findings need a follow-up. Completeness invariant in-process:
    #    expected = distinct kept/merged ordinals; a wired follow-up must carry
    #    exactly that many tasks. Found+complete → adopt (crash-resume). Found+
    #    partial → stop. Absent → scaffold from the persisted followup.yaml.
    expected_count = len(expected)
    existing = _find_followup_epic(ctx.data_dir, epic_id)
    if existing is not None:
        actual = existing["actual_tasks"]
        if actual == expected_count:
            # A prior run already scaffolded the follow-up; the crash was before
            # close. Adopt it, skip scaffold, close now → closed_with_followup.
            _close_epic(ctx, epic_id)
            return _emit_outcome(
                CloseOutcome.CLOSED_WITH_FOLLOWUP,
                epic_id,
                ctx,
                new_epic_id=existing["epic_id"],
            )
        # Partial follow-up — a crashed mid-scaffold run. Do NOT adopt or
        # double-create; stop for the human. No scaffold, no close.
        return _emit_outcome(
            CloseOutcome.PARTIAL_FOLLOWUP,
            epic_id,
            ctx,
            new_epic_id=existing["epic_id"],
            expected_tasks=expected_count,
            actual_tasks=actual,
        )

    # Absent: scaffold from the persisted followup.yaml. A missing followup.yaml
    # with surviving decisions is a fail-closed typed error (the close pipeline
    # ran `followup submit` before finalize).
    fp = followup_path(primary_repo, epic_id)
    if not fp.exists():
        _emit_finalize_error(
            "FOLLOWUP_MISSING",
            f"no follow-up plan for {epic_id} at {fp}, but the verdict has "
            f"{expected_count} surviving finding cluster(s); run "
            "`planctl followup submit` (via /plan:close) before close-finalize",
            details={"expected": str(fp), "expected_tasks": expected_count},
        )
    new_epic_id = _scaffold_followup(ctx, fp, epic_id)
    _close_epic(ctx, epic_id)
    return _emit_outcome(
        CloseOutcome.CLOSED_WITH_FOLLOWUP,
        epic_id,
        ctx,
        new_epic_id=new_epic_id,
    )


def _emit_outcome(
    outcome: CloseOutcome,
    epic_id: str,
    ctx,
    *,
    new_epic_id: str | None = None,
    fatal_reason: str | None = None,
    expected_tasks: int | None = None,
    actual_tasks: int | None = None,
) -> int:
    """Emit the typed close-finalize outcome envelope (read-only invocation line).

    finalize itself draws no ``.planctl/`` commit — ``epic close`` and
    ``scaffold`` already landed their own commits when this is reached. So the
    terminal envelope rides the read-only invocation footer (NULL subject/files),
    same shape as ``reconcile`` / ``resolve-task``.
    """
    from planctl.invocation import build_planctl_invocation_readonly
    from planctl.output import emit
    from planctl.store import now_iso

    data: dict[str, Any] = {
        "outcome": outcome.value,
        "epic_id": epic_id,
        "finalized_at": now_iso(),
    }
    if new_epic_id is not None:
        data["new_epic_id"] = new_epic_id
    if fatal_reason is not None:
        data["fatal_reason"] = fatal_reason
    if expected_tasks is not None:
        data["expected_tasks"] = expected_tasks
    if actual_tasks is not None:
        data["actual_tasks"] = actual_tasks

    pc = build_planctl_invocation_readonly(
        "close-finalize", epic_id, repo_root=ctx.project_path
    )
    emit(data, planctl_invocation=pc)
    return 0
