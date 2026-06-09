"""planctl reconcile — read-only post-worker verdict (fn-6 task .1).

The keystone of the content-blind ``/plan:work`` orchestrator's post-worker
phase: ONE read-only call that collapses ``planctl show`` + source-commit
forensics + HEAD-visibility + epic tally into a single typed verdict the
orchestrator switches on mechanically. The symmetric bookend to fn-5's
pre-worker brief handoff.

The verdict is computed entirely from planctl-native data — there is NO keeper
shell-out, no mutation, no commit. This preserves the one-way keeper→planctl
dependency and planctl's extractability. Delivery cleanliness (the
``dirty_session_files`` attribution that would need keeper) belongs to the
WORKER under the content-blind division, so the orchestrator's verdict never
needs it.

Signals → verdict TRUTH TABLE (the load-bearing artifact; pinned in
:data:`Verdict` + an exhaustiveness test):

* ``merge_task_state`` status ``done`` AND ``worker_done_at`` visible in
  ``HEAD:<task.json>`` → ``done``.
* status ``done`` AND ``worker_done_at`` NOT in HEAD → ``state_uncommitted``
  (the ``done`` auto-commit failed; fix is a re-run of ``planctl done``).
* status ``in_progress`` AND a trailer-authentic ``Task: <id>`` commit exists →
  ``in_progress_committed``.
* status ``in_progress`` AND no such commit → ``in_progress_uncommitted``.
* status ``blocked`` → ``blocked`` (carries ``blocked_reason``).
* status ``todo`` → ``not_started``.
* any git subprocess failure (missing binary / not a repo / unexpected
  non-zero) → ``tooling_error`` (fail-closed; NEVER silently
  ``not_started``/``done``).

Source-commit detection is trailer-authentic, NOT a substring match: it
confirms a REAL ``Task:`` trailer whose value EXACTLY equals ``<task_id>``,
killing both the prose false-match and the ``fn-5.1`` / ``fn-5.10`` substring
collision. It scans the task's ``target_repo`` plus every
``epic.touched_repos`` entry (falling back to ``primary_repo``).
``state_head_visible`` ``cat-file``s against ``state_repo`` — a DISTINCT cwd
from the source scan — guarding the unborn-branch case first.
"""

from __future__ import annotations

import subprocess
import sys
from enum import Enum
from pathlib import Path
from types import SimpleNamespace
from typing import Any, NoReturn


class Verdict(str, Enum):
    """The seven post-worker verdicts the orchestrator switches on.

    ``str, Enum`` (not ``StrEnum``) so ``.value`` serializes to a plain JSON
    string on every supported interpreter and ``==`` against a bare literal
    works in tests. Every member here MUST have an orchestrator handler — the
    exhaustiveness test in ``tests/test_reconcile.py`` asserts it.
    """

    DONE = "done"
    IN_PROGRESS_COMMITTED = "in_progress_committed"
    IN_PROGRESS_UNCOMMITTED = "in_progress_uncommitted"
    BLOCKED = "blocked"
    STATE_UNCOMMITTED = "state_uncommitted"
    NOT_STARTED = "not_started"
    TOOLING_ERROR = "tooling_error"


# Sentinel raised by the git helpers on ANY subprocess failure so the verb
# fails closed into a `tooling_error` verdict rather than a clean one.
class _GitError(Exception):
    """A git subprocess failed unexpectedly — fail-closed signal."""


def _emit_reconcile_error(
    code: str, message: str, *, details: dict[str, Any] | None = None
) -> NoReturn:
    """Emit a typed reconcile error envelope and exit 1.

    Mirrors ``run_resolve_task._emit_resolve_error`` — shape
    ``{"success": false, "error": {"code", "message", "details"}}``, no
    ``planctl_invocation`` line, sentinel set on the click context so the
    decorator does not emit a trailing read-only envelope after the failure.
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

    Mirrors ``run_resolve_task._set_invocation_sentinel``.
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
    """Build a ProjectContext from a project root dir (the ``.planctl/`` parent)."""
    from planctl.project import ProjectContext

    planctl_dir = project_root / ".planctl"
    return ProjectContext(
        name=project_root.name,
        data_dir=planctl_dir,
        state_dir=planctl_dir / "state",
        project_path=project_root,
    )


def _resolve_project_for_task(task_id: str, project: str | None):
    """Resolve the owning project for *task_id* cwd-agnostically.

    Same shape as ``run_resolve_task._resolve_project_for_task`` — the
    routing variant with no "filter to claimable on ambiguity" pass. Any
    same-id collision surfaces as ``AMBIGUOUS_TASK_ID``; ``--project <path>``
    is the disambiguation escape hatch.
    """
    from planctl.discovery import find_projects_with_task

    if project is not None:
        project_root = Path(project).expanduser().resolve()
        if not (project_root / ".planctl").is_dir():
            _emit_reconcile_error(
                "NOT_A_PROJECT",
                f"No planctl project found at {project_root}. Run 'planctl init' first.",
            )
        ctx = _context_for_root(project_root)
        if not (ctx.data_dir / "tasks" / f"{task_id}.json").exists():
            _emit_reconcile_error(
                "TASK_NOT_FOUND",
                f"Task not found in {project_root}: {task_id}",
            )
        return ctx

    matches = find_projects_with_task(task_id)
    if not matches:
        _emit_reconcile_error("TASK_NOT_FOUND", f"Task not found: {task_id}")

    if len(matches) == 1:
        return _context_for_root(matches[0])

    _emit_reconcile_error(
        "AMBIGUOUS_TASK_ID",
        f"Task {task_id} exists in multiple projects; pass --project <path>.",
        details={"candidates": [str(p) for p in matches]},
    )


# ---------------------------------------------------------------------------
# git helpers — fail-closed. Any unexpected non-zero / missing binary raises
# _GitError so the verb collapses to a `tooling_error` verdict.
# ---------------------------------------------------------------------------

# %x1f (ASCII unit separator) is the per-record field delimiter — it cannot
# appear in a sha or a trailer value, so the split is unambiguous even when a
# trailer value itself contains commas or spaces.
_FIELD_SEP = "\x1f"


def _run_git(argv: list[str], cwd: str) -> subprocess.CompletedProcess[str]:
    """Run a git subprocess in *cwd*, raising :class:`_GitError` on failure.

    A missing git binary (``FileNotFoundError``) or any unexpected non-zero
    exit raises — the caller maps that to the fail-closed ``tooling_error``
    verdict. Callers that legitimately expect a non-zero exit (e.g.
    ``rev-parse --verify HEAD`` on an unborn branch) use :func:`_run_git_raw`.
    """
    proc = _run_git_raw(argv, cwd)
    if proc.returncode != 0:
        raise _GitError(
            f"git {' '.join(argv)} failed in {cwd} "
            f"(exit {proc.returncode}): {proc.stderr.strip()}"
        )
    return proc


def _run_git_raw(argv: list[str], cwd: str) -> subprocess.CompletedProcess[str]:
    """Run a git subprocess, returning the completed process without exit check.

    A missing git binary still raises :class:`_GitError` (the tool is absent —
    fail closed); the caller inspects ``returncode`` for the expected-non-zero
    cases (unborn branch, path-not-in-HEAD).
    """
    try:
        return subprocess.run(
            ["git", *argv],
            cwd=cwd,
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as exc:
        raise _GitError(f"git binary not found: {exc}") from exc


def _is_git_repo(cwd: str) -> bool:
    """True when *cwd* is inside a git work tree.

    A non-repo dir is NOT a tooling error for the SOURCE scan — a task's
    ``target_repo`` may legitimately not be a checked-out repo on this host;
    we just find no commits there. ``rev-parse --is-inside-work-tree`` exits
    128 outside a repo, which we read as ``False`` rather than raising.
    """
    if not Path(cwd).is_dir():
        return False
    proc = _run_git_raw(["rev-parse", "--is-inside-work-tree"], cwd)
    return proc.returncode == 0 and proc.stdout.strip() == "true"


def _has_head(cwd: str) -> bool:
    """True when *cwd*'s HEAD points at a real commit (born branch).

    ``rev-parse --verify HEAD`` exits 128 on an empty/orphan repo — the
    unborn-branch case. We read that as ``False`` (a distinct signal, NOT a
    tooling error). A missing git binary still raises via :func:`_run_git_raw`.
    """
    proc = _run_git_raw(["rev-parse", "--verify", "HEAD"], cwd)
    return proc.returncode == 0


def _find_source_commits(task_id: str, repo: str) -> list[str]:
    """Return SHAs in *repo* carrying a trailer-authentic ``Task: <task_id>``.

    Trailer-authentic, NOT substring: ``git log`` emits each commit's sha and
    the parsed value of its ``Task`` trailer (``%(trailers:key=Task,
    valueonly=true)``), field-separated by ``%x1f``. We match the trailer value
    EXACTLY against *task_id*. This kills both the prose false-match (a body
    line ``Task: <id>`` is not a trailer and is not surfaced by the
    ``trailers:key=`` formatter) AND the ``fn-5.1`` / ``fn-5.10`` substring
    collision (exact-equality, not ``in``).

    A trailer block can carry more than one ``Task:`` line; ``valueonly=true``
    joins multiple values with a separator, so we split the trailer field on
    both newlines and commas before the exact-equality check.

    Returns ``[]`` when *repo* is not a git work tree or has no born HEAD —
    those are legitimate empty-scan cases, not failures. Any OTHER git failure
    raises :class:`_GitError` (fail closed).
    """
    if not _is_git_repo(repo):
        return []
    if not _has_head(repo):
        return []

    # `%H` full sha, `%x1f` unit-separator, then the joined Task-trailer values.
    fmt = f"--format=%H{_FIELD_SEP}%(trailers:key=Task,valueonly=true)"
    proc = _run_git(["log", fmt], repo)

    shas: list[str] = []
    for record in proc.stdout.split("\n"):
        if _FIELD_SEP not in record:
            continue
        sha, trailer_blob = record.split(_FIELD_SEP, 1)
        sha = sha.strip()
        if not sha:
            continue
        # A commit may carry several `Task:` trailers; valueonly joins them.
        # Normalize commas → newlines so both `Task: a, b` and stacked
        # `Task: a` / `Task: b` forms split into individual candidate values.
        values = trailer_blob.replace(",", "\n").splitlines()
        if any(v.strip() == task_id for v in values):
            shas.append(sha)
    return shas


def _state_head_visible(state_repo: str, task_id: str) -> bool:
    """True when the committed ``HEAD:<task.json>`` carries ``worker_done_at``.

    Runs ``cat-file`` against ``state_repo`` (NOT ``target_repo``, NOT cwd) at
    the repo-root-relative path ``.planctl/tasks/<id>.json`` (no leading slash).
    Guards the unborn-branch case first via :func:`_has_head`.

    The runtime status sidecar is gitignored and never in HEAD — so we check
    ``worker_done_at`` on the TRACKED task JSON blob, which ``done`` stamps
    inline (run_done.py). ``state_uncommitted`` is the on-disk merged status
    being ``done`` while this returns ``False`` (the path isn't in HEAD, or the
    committed blob lacks the stamp).

    Returns ``False`` (not a tooling error) when the repo is unborn or the path
    isn't in HEAD. Raises :class:`_GitError` on any other git failure.
    """
    import json

    if not Path(state_repo).is_dir():
        raise _GitError(f"state_repo is not a directory: {state_repo}")
    if not _is_git_repo(state_repo):
        raise _GitError(f"state_repo is not a git work tree: {state_repo}")
    if not _has_head(state_repo):
        # Unborn branch — nothing is committed yet. Distinct signal, not an error.
        return False

    relpath = f".planctl/tasks/{task_id}.json"
    # `cat-file -e` exits 0 if the object exists, non-zero if the path isn't in
    # HEAD. We need the blob CONTENTS to check `worker_done_at`, so go straight
    # to `cat-file blob` and treat a non-zero exit as "not in HEAD".
    proc = _run_git_raw(["cat-file", "blob", f"HEAD:{relpath}"], state_repo)
    if proc.returncode != 0:
        # Path not present in HEAD (or a tree, not a blob) — committed JSON is
        # not yet visible. `state_uncommitted` when the on-disk status is done.
        return False
    try:
        committed = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise _GitError(f"HEAD:{relpath} is not valid JSON: {exc}") from exc
    return bool(committed.get("worker_done_at"))


def _epic_progress(data_dir: Path, epic_id: str, state_store) -> dict[str, int]:
    """Return ``{done, total}`` for *epic_id*'s tasks — REPORTING ONLY.

    NOT a verdict input (absent from the truth table). Filters
    ``tasks_dir.glob("*.json")`` to this epic's tasks and reuses the
    ``merge_task_state`` + tally loop (run_status.py shape). Degrades to
    ``{done: 0, total: 0}`` if the tasks dir is missing.
    """
    from planctl.ids import epic_id_from_task
    from planctl.models import merge_task_state
    from planctl.store import load_json_safe

    tasks_dir = data_dir / "tasks"
    done = 0
    total = 0
    if tasks_dir.exists():
        for f in tasks_dir.glob("*.json"):
            task_def = load_json_safe(f)
            if not task_def:
                continue
            tid = task_def.get("id", f.stem)
            try:
                if epic_id_from_task(tid) != epic_id:
                    continue
            except ValueError:
                continue
            runtime = state_store.load_runtime(tid)
            merged = merge_task_state(task_def, runtime)
            total += 1
            if merged.get("status") == "done":
                done += 1
    return {"done": done, "total": total}


def _compute_verdict(
    status: str,
    *,
    has_source_commit: bool,
    state_head_visible: bool,
) -> Verdict:
    """Map (status, git signals) → :class:`Verdict` per the truth table.

    Pure function over already-collected signals so the truth table is one
    readable block and the exhaustiveness test can drive it directly.
    """
    if status == "done":
        return Verdict.DONE if state_head_visible else Verdict.STATE_UNCOMMITTED
    if status == "in_progress":
        return (
            Verdict.IN_PROGRESS_COMMITTED
            if has_source_commit
            else Verdict.IN_PROGRESS_UNCOMMITTED
        )
    if status == "blocked":
        return Verdict.BLOCKED
    # status == "todo" (or any unexpected literal merge produced) → not started.
    return Verdict.NOT_STARTED


def run(args: SimpleNamespace) -> int:
    from planctl.ids import epic_id_from_task, is_task_id
    from planctl.invocation import build_planctl_invocation_readonly
    from planctl.models import merge_task_state, normalize_task
    from planctl.output import emit
    from planctl.runtime_status import _expected_worker_cwd
    from planctl.store import LocalFileStateStore, load_json, now_iso

    task_id: str = args.task_id
    project: str | None = getattr(args, "project", None)

    # 1. validate id
    if not is_task_id(task_id):
        _emit_reconcile_error("BAD_TASK_ID", f"Invalid task ID: {task_id}")

    # 2. resolve owning project cwd-agnostically (roots discovery or --project)
    ctx = _resolve_project_for_task(task_id, project)
    data_dir = ctx.data_dir

    task_path = data_dir / "tasks" / f"{task_id}.json"
    task_def = normalize_task(load_json(task_path))

    epic_id = epic_id_from_task(task_id)
    epic_path = data_dir / "epics" / f"{epic_id}.json"
    epic_def: dict[str, Any] = load_json(epic_path) if epic_path.exists() else {}

    # 3. merged runtime status (definition + state-dir overlay).
    state_store = LocalFileStateStore(ctx.state_dir)
    runtime = state_store.load_runtime(task_id)
    merged = merge_task_state(task_def, runtime)
    status = merged.get("status", "todo")
    blocked_reason = merged.get("blocked_reason") if status == "blocked" else None

    # 4. resolve repos. SOURCE scan runs against target_repo + touched_repos;
    #    state cat-file runs against state_repo — a DISTINCT cwd (commit.py
    #    precedence: epic.primary_repo → project_path).
    proj_path = str(ctx.project_path)
    target_repo = str(
        Path(_expected_worker_cwd(task_def, epic_def, proj_path)).resolve()
    )
    primary_repo = str(Path(epic_def.get("primary_repo") or proj_path).resolve())
    state_repo = primary_repo

    # Source-scan repo set: target_repo, then every touched_repos entry, then
    # primary_repo — de-duplicated, order-preserving (realpath-normalized).
    scan_repos: list[str] = [target_repo]
    for entry in epic_def.get("touched_repos") or []:
        if isinstance(entry, str) and entry:
            scan_repos.append(str(Path(entry).expanduser().resolve()))
    scan_repos.append(primary_repo)
    seen: set[str] = set()
    ordered_scan_repos = [r for r in scan_repos if not (r in seen or seen.add(r))]

    # 5. collect git signals — fail closed to `tooling_error` on any git error.
    source_commits: list[dict[str, str]] = []
    try:
        for repo in ordered_scan_repos:
            for sha in _find_source_commits(task_id, repo):
                source_commits.append({"sha": sha, "repo": repo})
        state_head_visible = _state_head_visible(state_repo, task_id)
        verdict = _compute_verdict(
            status,
            has_source_commit=bool(source_commits),
            state_head_visible=state_head_visible,
        )
    except _GitError:
        # Fail closed: never a clean verdict on a git failure. Surface the raw
        # signals collected so far (possibly partial) for debuggability.
        verdict = Verdict.TOOLING_ERROR
        state_head_visible = False

    # 6. epic progress — reporting only, never a verdict input. Degrade gracefully.
    epic_progress = _epic_progress(data_dir, epic_id, state_store)

    pc = build_planctl_invocation_readonly(
        "reconcile", task_id, repo_root=ctx.project_path
    )
    emit(
        {
            "verdict": verdict.value,
            "task_id": task_id,
            "epic_id": epic_id,
            "status": status,
            "source_commits": source_commits,
            "state_head_visible": state_head_visible,
            "epic_progress": epic_progress,
            "assessed_at": now_iso(),
            "blocked_reason": blocked_reason,
        },
        planctl_invocation=pc,
    )
    return 0
