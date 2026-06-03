"""planctl epic rm — remove an epic and all its artifacts (fn-623 task .1).

Companion to `epic close`: where close stamps `closer_done_at` and leaves the
epic on the board for the approval/audit/keeper-stamp cycle, `rm` is the
sanctioned delete verb — it physically unlinks every file the epic owns
(epic JSON, task JSONs, epic + task spec markdowns, runtime state files,
lock files) and auto-commits the deletions into the owning project's
`.planctl/`.

Resolution order
----------------

Cwd-then-global via `discovery.resolve_epic_globally`:

1. If cwd is a planctl project and `.planctl/epics/<id>.json` exists, that's
   the owner.
2. Otherwise scan configured `roots` (`planctl.config.load_roots`). Exactly
   one match wins; zero is not-found; many is `ambiguous_id` — surface
   `--project <path>` and refuse to silently pick.

`--project <path>` is the escape valve for the ambiguous case (and for
operators who want to operate on a foreign project without `cd`'ing into
it). It bypasses cwd + roots discovery entirely.

Auto-commit routing
-------------------

The state commit must land in the *owning* repo's `.planctl/`, not the
caller's cwd repo (a major-mode bug we lived with for the `approve` rewrite
— see `run_approve.py`). We read `epic.primary_repo` BEFORE deleting the
epic JSON and pass it through as `primary_repo=` to
`build_planctl_invocation`, which the auto-commit step routes by.

Deletion → commit pathspec
--------------------------

`auto_commit_from_invocation` stages `touched ∩ dirty` — touched paths come
from the session log written by `_record_touched`, dirty paths come from
`git status --porcelain` against `.planctl/`. An `os.unlink` does NOT call
`_record_touched` itself, so a naive deletion loop leaves the deletions out
of the staged pathspec and silently never commits them. We therefore call
`_record_touched` for EVERY path BEFORE unlinking it.

Guards
------

* `--dry-run` previews the unlink set and exits without writing.
* `in_progress` tasks (or any task holding a `.lock`) block deletion unless
  `--force`. `--force` short-circuits the live-work check entirely.
* Missing files are idempotent success (`FileNotFoundError` swallowed per
  path).
* `epic_id` is validated against `[A-Za-z0-9_-]+` upfront as a traversal
  guard so a malicious id can never escape `.planctl/` via `..` segments.
* Downstream dependents (other epics whose `depends_on_epics` contains this
  id) are surfaced in the envelope as a `warnings` list — they are NOT
  blockers. Keeper re-stamps them `dangling` on the EpicDeleted fold; the
  human re-points them with `epic rm-dep` or `epic add-dep` as needed.

NOT in `VALIDATION_RESTAMP_VERBS` — there is nothing to restamp when the
epic ceases to exist.
"""

from __future__ import annotations

import contextlib
import re
from pathlib import Path
from types import SimpleNamespace

# Traversal guard: only filename-safe characters allowed in an epic_id. The
# real id regex (`ids.ID_REGEX`) is stricter, but `[A-Za-z0-9_-]+` is the
# minimum guarantee needed before we glob/unlink — any character that could
# break out of `.planctl/specs/` etc. is rejected here.
_EPIC_ID_PATH_RE = re.compile(r"^[A-Za-z0-9_\-]+$")


def _context_for_root(project_root: Path):
    """Build a ProjectContext from a project root dir (the `.planctl/` parent).

    Mirrors `run_approve._context_for_root`. Kept private to this module so
    a future refactor moving it into `project.py` is mechanical.
    """
    from planctl.project import ProjectContext

    planctl_dir = project_root / ".planctl"
    return ProjectContext(
        name=project_root.name,
        data_dir=planctl_dir,
        state_dir=planctl_dir / "state",
        project_path=project_root,
    )


def _resolve_owning_project(epic_id: str, project: str | None):
    """Resolve the project that owns *epic_id*, honoring `--project`.

    1. `--project <path>`: bypasses cwd + discovery. Fails closed if the
       path is not a planctl project or if the epic JSON isn't present.
    2. Otherwise: `resolve_epic_globally` (cwd-then-global). Ambiguous
       results are a hard error listing every owner and suggesting
       `--project`.

    Returns a `ProjectContext` for the owning project on success.
    """
    from planctl.discovery import resolve_epic_globally
    from planctl.output import emit_error

    if project is not None:
        project_root = Path(project).expanduser().resolve()
        if not (project_root / ".planctl").is_dir():
            emit_error(
                f"No planctl project found at {project_root}. Run 'planctl init' first."
            )
        epic_path = project_root / ".planctl" / "epics" / f"{epic_id}.json"
        if not epic_path.exists():
            emit_error(f"Epic not found in {project_root}: {epic_id}")
        return _context_for_root(project_root)

    result = resolve_epic_globally(epic_id)
    if result.ambiguous:
        candidates = ", ".join(str(p) for p in result.owners)
        emit_error(
            f"Epic {epic_id} exists in multiple projects; "
            f"pass --project <path>. Candidates: {candidates}"
        )
    if not result.resolved:
        emit_error(f"Epic not found: {epic_id}")
    assert result.project_path is not None  # narrowed by .resolved
    return _context_for_root(result.project_path)


def _collect_unlink_set(epic_id: str, ctx) -> list[Path]:
    """Return the sorted list of every path that belongs to *epic_id*.

    Set:
    * `epics/<id>.json`
    * `specs/<id>.md`   — the epic spec
    * `specs/<id>.*.md` — every task spec
    * `tasks/<id>.*.json`
    * `state/tasks/<id>.*.state.json`
    * `state/locks/<id>.*.lock`

    Missing files / dirs are just absent from the result (no error). The
    list is sorted for deterministic preview output.
    """
    data_dir: Path = ctx.data_dir
    state_dir: Path = ctx.state_dir
    paths: list[Path] = []

    epic_json = data_dir / "epics" / f"{epic_id}.json"
    if epic_json.exists():
        paths.append(epic_json)

    specs_dir = data_dir / "specs"
    if specs_dir.exists():
        epic_spec = specs_dir / f"{epic_id}.md"
        if epic_spec.exists():
            paths.append(epic_spec)
        # Task specs share the prefix; `Path.glob` handles missing files
        # by yielding nothing.
        paths.extend(sorted(specs_dir.glob(f"{epic_id}.*.md")))

    tasks_dir = data_dir / "tasks"
    if tasks_dir.exists():
        paths.extend(sorted(tasks_dir.glob(f"{epic_id}.*.json")))

    state_tasks_dir = state_dir / "tasks"
    if state_tasks_dir.exists():
        paths.extend(sorted(state_tasks_dir.glob(f"{epic_id}.*.state.json")))

    state_locks_dir = state_dir / "locks"
    if state_locks_dir.exists():
        paths.extend(sorted(state_locks_dir.glob(f"{epic_id}.*.lock")))

    # Dedupe and sort while preserving insertion intent (epic JSON first is
    # purely cosmetic; the auto-commit doesn't care about order).
    seen: set[Path] = set()
    unique: list[Path] = []
    for p in paths:
        if p in seen:
            continue
        seen.add(p)
        unique.append(p)
    return unique


def _collect_live_tasks(epic_id: str, ctx) -> list[str]:
    """Return task ids that are `in_progress` or hold a lock file on disk.

    Mirrors `run_epic_close.py`'s `not_done`-style scan, narrowed to the
    statuses that *actually block deletion* (an unstarted `todo` task is
    fine to remove — the deletion is the whole point of the verb).

    Lock files are checked structurally: any `state/locks/<id>.*.lock`
    presence counts as a live lock regardless of whether the holder is
    still alive (a stale lock is itself a signal someone was just here).
    """
    from planctl.models import merge_task_state
    from planctl.store import LocalFileStateStore, load_json_safe

    live: list[str] = []
    data_dir: Path = ctx.data_dir
    state_store = LocalFileStateStore(ctx.state_dir)

    tasks_dir = data_dir / "tasks"
    if tasks_dir.exists():
        for f in sorted(tasks_dir.glob(f"{epic_id}.*.json")):
            task_def = load_json_safe(f)
            if task_def is None:
                continue
            tid = task_def.get("id", f.stem)
            runtime = state_store.load_runtime(tid)
            merged = merge_task_state(task_def, runtime)
            if merged.get("status") == "in_progress":
                live.append(f"{tid} (in_progress)")

    locks_dir = ctx.state_dir / "locks"
    if locks_dir.exists():
        for lock in sorted(locks_dir.glob(f"{epic_id}.*.lock")):
            tid = lock.stem  # `<id>.M`
            entry = f"{tid} (locked)"
            if entry not in live:
                live.append(entry)

    return live


def _collect_dangling_dependents(epic_id: str, ctx) -> list[str]:
    """Return ids of other epics in the same project whose `depends_on_epics`
    references *epic_id*.

    Surfaced as a non-blocking warning — the keeper EpicDeleted fold
    re-stamps these as `dangling` and the human re-points them downstream.
    Cross-project dependents are intentionally out of scope here (resolving
    them would require a `discover_projects` scan; the warning is advisory,
    not a blocker, so the cost isn't justified).
    """
    from planctl.store import load_json_safe

    epics_dir: Path = ctx.data_dir / "epics"
    if not epics_dir.exists():
        return []

    dependents: list[str] = []
    for f in sorted(epics_dir.glob("fn-*.json")):
        if f.stem == epic_id:
            continue
        epic_def = load_json_safe(f)
        if not epic_def:
            continue
        deps = epic_def.get("depends_on_epics") or []
        if epic_id in deps:
            dependents.append(epic_def.get("id", f.stem))
    return dependents


def run(args: SimpleNamespace) -> int:
    from planctl.output import emit, emit_error
    from planctl.store import _record_touched, load_json_safe

    epic_id: str = args.epic_id
    force: bool = bool(getattr(args, "force", False))
    dry_run: bool = bool(getattr(args, "dry_run", False))
    project: str | None = getattr(args, "project", None)

    # Traversal guard: refuse any id that could break out of .planctl/
    # before we touch the filesystem with it.
    if not _EPIC_ID_PATH_RE.match(epic_id or ""):
        emit_error(f"Invalid epic id: {epic_id!r}")

    ctx = _resolve_owning_project(epic_id, project)
    data_dir = ctx.data_dir

    # Read epic.primary_repo BEFORE collecting/unlinking — the auto-commit
    # needs to route by it, and the epic JSON is part of the unlink set.
    epic_path = data_dir / "epics" / f"{epic_id}.json"
    epic_def = load_json_safe(epic_path) or {}
    primary_repo = epic_def.get("primary_repo")

    # Guard: refuse if any task is in_progress or holds a lock unless
    # --force. Mirrors run_epic_close's not_done-style collection, narrowed
    # to the live-work statuses.
    if not force:
        live = _collect_live_tasks(epic_id, ctx)
        if live:
            emit_error(
                f"Cannot rm {epic_id}: {len(live)} task(s) live: "
                f"{', '.join(live)}. Re-run with --force to override."
            )

    unlink_set = _collect_unlink_set(epic_id, ctx)
    dependents = _collect_dangling_dependents(epic_id, ctx)

    # Repo-relative paths for the envelope payload (POSIX form so they
    # match the touched-path log format).
    rel_paths = []
    repo_root = ctx.project_path
    for p in unlink_set:
        try:
            rel = p.resolve().relative_to(repo_root.resolve()).as_posix()
        except ValueError:
            rel = p.as_posix()
        rel_paths.append(rel)

    warnings: list[str] = []
    if dependents:
        warnings.append(
            f"{len(dependents)} dependent epic(s) will become dangling: "
            f"{', '.join(dependents)}"
        )

    if dry_run:
        # No writes, no commit, no planctl_invocation — read-only preview.
        # Routes through `emit()` without `planctl_invocation=` so the
        # click decorator emits its own read-only invocation line.
        preview_count = sum(
            1
            for p in unlink_set
            if p.parent.name == "tasks" and p.parent.parent.name == ".planctl"
        )
        emit(
            {
                "epic_id": epic_id,
                "dry_run": True,
                "removed_files": rel_paths,
                "task_count": preview_count,
                "dependents": dependents,
                "warnings": warnings,
            }
        )
        return 0

    # Delete: record-then-unlink per path so the auto-commit step picks the
    # deletion up via the touched ∩ dirty pathspec intersection. Missing
    # files are idempotent success (we collected via existence check, but a
    # racy concurrent unlink is fine too).
    for p in unlink_set:
        # `_record_touched` resolves the path's parent up the tree to
        # find `.planctl/`. We pass `data_dir` explicitly so the lookup
        # never has to .resolve() the about-to-be-deleted file (defensive
        # — the recorder is exception-swallowing anyway). Wrap in
        # suppress(Exception) belt-and-suspenders so a recorder bug never
        # strands a partial delete.
        with contextlib.suppress(Exception):
            _record_touched(p, data_dir=data_dir)
        # Idempotent: another caller (or a prior crashed `rm`) already
        # cleared this path. The auto-commit step will simply not see it
        # in the dirty set and won't try to stage it.
        with contextlib.suppress(FileNotFoundError):
            p.unlink()

    # Count only task DEFINITION JSONs (`tasks/<id>.M.json`), not the
    # parallel state files under `state/tasks/...` which we also unlink.
    task_count = sum(
        1
        for p in unlink_set
        if p.parent.name == "tasks" and p.parent.parent.name == ".planctl"
    )

    # Route through the central seam. emit(verb=...) builds
    # build_planctl_invocation internally and runs the per-verb auto-commit.
    # epic rm is delete-only — the deletes already landed on disk before this
    # call, and a pre-commit raise from the seam leaves them deleted (§10
    # no-rollback; the commit surfaces the failure and the human re-runs from
    # a clean state).
    emit(
        {
            "epic_id": epic_id,
            "removed_files": rel_paths,
            "task_count": task_count,
            "dependents": dependents,
            "warnings": warnings,
        },
        verb="rm",
        target=epic_id,
        repo_root=ctx.project_path,
        primary_repo=primary_repo,
    )
    return 0
