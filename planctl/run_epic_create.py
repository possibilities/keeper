"""planctl epic create - Create a new epic."""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

from planctl.repo_inference import expand_path as _expand_path

# Global epic-id lock. Serializes the global-name-check → write-epic critical
# section across concurrent creates in different projects so two sessions can't
# pass the name-check and then both write the same fn-N-slug. Local to the
# host; the work under it is sub-millisecond, so a plain blocking LOCK_EX is
# sufficient.
_EPIC_ID_LOCK_PATH = Path("~/.local/state/planctl/epic-id.lock").expanduser()

__all__ = ["_expand_path", "_epic_id_lock", "_check_global_name_unique", "run"]


@contextmanager
def _epic_id_lock():
    """Acquire the global epic-id flock for the create critical section.

    Fail-soft: if the lock file can't be created / locked (e.g. unwritable
    state dir on a foreign system), yield without a lock rather than hard-break
    ``epic create``. The per-project ``epic_path.exists()`` collision check
    remains the backstop in that degraded case.
    """
    import fcntl

    fd = None
    try:
        _EPIC_ID_LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
        fd = open(_EPIC_ID_LOCK_PATH, "w")  # noqa: SIM115 — released in finally
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    except OSError:
        # Could not establish the lock — proceed unlocked (fail-soft).
        yield
    finally:
        if fd is not None:
            import contextlib

            with contextlib.suppress(OSError):
                fcntl.flock(fd, fcntl.LOCK_UN)
            fd.close()


def _check_global_name_unique(epic_id: str, local_project_path) -> Path | None:
    """Return the owning project path if ``epic_id`` already exists elsewhere.

    Scans every discovered project (other than ``local_project_path``) and
    returns the first project whose ``.planctl/`` already carries an epic JSON
    or spec file named ``epic_id``. Returns ``None`` when the id is free.

    Fail-soft: if discovery raises or yields nothing, returns ``None`` so a
    fresh / foreign system never hard-breaks epic creation — the per-project
    ``epic_path.exists()`` backstop still catches same-project collisions.
    """
    from planctl.discovery import discover_projects
    from planctl.ids import scan_epic_ids_global

    try:
        projects = discover_projects()
    except Exception:
        return None

    local = Path(local_project_path).resolve()
    foreign = [p for p in projects if Path(p).resolve() != local]
    if not foreign:
        return None

    owners = scan_epic_ids_global(foreign)
    return owners.get(epic_id)


def run(args: SimpleNamespace) -> int:
    from planctl.ids import generate_suffix, scan_max_epic_id, slugify
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.store import atomic_write, atomic_write_json, now_iso

    title: str = args.title
    branch: str | None = args.branch
    spec_file: str | None = args.spec_file
    primary_repo_arg: str | None = getattr(args, "primary_repo", None)
    touched_repos_arg: str | None = getattr(args, "touched_repos", None)

    ctx = resolve_project()
    data_dir = ctx.data_dir

    # Resolve primary_repo: CLI arg (expanded) or default to ctx.project_path
    primary_repo: str = (
        _expand_path(primary_repo_arg) if primary_repo_arg else str(ctx.project_path)
    )

    # Resolve touched_repos: CLI comma-list or default to [primary_repo]
    if touched_repos_arg:
        touched_repos = [
            _expand_path(p.strip()) for p in touched_repos_arg.split(",") if p.strip()
        ]
    else:
        touched_repos = [primary_repo]

    spec_content = ""
    if spec_file:
        spec_content = Path(spec_file).read_text(encoding="utf-8")

    # fn-629 task .2: track every write so the central seam at output.emit()
    # can unwind on a pre-commit failure. epic create writes two files
    # (epic JSON + epic spec) — both are fresh-mint paths, so unwinding on
    # a downstream failure leaves zero orphan files. Allocated INSIDE the
    # lock; the emit() call routes through the seam AFTER the lock releases
    # so the id-allocation lock and the commit lock stay disjoint (no
    # nesting — the commit lock is held across a git commit, the id lock is
    # sub-millisecond).
    written_paths: list[Path] = []

    # Allocate epic ID + write under the global epic-id lock. Numbering is
    # per-project (scan_max_epic_id on the local data dir); the lock serializes
    # the global-name uniqueness check so two concurrent creates in different
    # projects can't both pass the check and write the same fn-N-slug.
    with _epic_id_lock():
        max_n = scan_max_epic_id(data_dir)
        epic_num = max_n + 1
        slug = slugify(title)
        epic_id = (
            f"fn-{epic_num}-{slug}" if slug else f"fn-{epic_num}-{generate_suffix()}"
        )

        branch_name = branch or epic_id

        # Global-name uniqueness check across all discovered projects.
        foreign_owner = _check_global_name_unique(epic_id, ctx.project_path)
        if foreign_owner is not None:
            emit_error(f"Epic id {epic_id} already exists in project {foreign_owner}")

        # Collision check (local backstop to the global-name check).
        epic_path = data_dir / "epics" / f"{epic_id}.json"
        spec_path = data_dir / "specs" / f"{epic_id}.md"
        if epic_path.exists():
            emit_error(f"File collision: {epic_path} already exists")
        if spec_path.exists():
            emit_error(f"File collision: {spec_path} already exists")

        now = now_iso()
        epic_def = {
            "id": epic_id,
            "title": title,
            "status": "open",
            # fn-592: pin the approval gate to "pending" at mint time so the
            # epic is self-describing and immune to keeperd's schema-v13
            # approval migration, which backfills any field-LESS epic to
            # "approved" (mirrors run_scaffold.py).
            "approval": "pending",
            "branch_name": branch_name,
            "depends_on_epics": [],
            "plan_review_status": "unknown",
            "plan_reviewed_at": None,
            "primary_repo": primary_repo,
            "touched_repos": touched_repos,
            "created_at": now,
            "updated_at": now,
        }

        # Write epic definition + spec inside the lock so the just-minted N is
        # observable to the next waiter's scan before it computes its own max.
        # Mid-write raise (KeyboardInterrupt / disk-full) → unwind any partial
        # tree so scan_max_epic_id stays unchanged.
        try:
            atomic_write_json(epic_path, epic_def)
            written_paths.append(epic_path)
            atomic_write(spec_path, spec_content)
            written_paths.append(spec_path)
        except BaseException:
            import contextlib as _ctx

            for p in written_paths:
                with _ctx.suppress(OSError):
                    p.unlink(missing_ok=True)
            raise

    # fn-629 task .2: route through the central seam. emit(verb=...) builds
    # build_planctl_invocation internally and unwinds ``written_paths`` on
    # any pre-commit failure (invocation-build raise, commit lock-acquire
    # timeout, git status/add/commit error). The commit lock and the (now
    # released) ``_epic_id_lock`` stay disjoint.
    emit(
        {"epic": epic_def},
        verb="create",
        target=epic_id,
        repo_root=ctx.project_path,
        primary_repo=primary_repo,
        written_paths=written_paths,
    )
    return 0
