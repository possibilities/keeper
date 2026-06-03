"""planctl multi-project discovery (fn-542).

Pure filesystem scan: given the configured ``roots`` (parent directories), walk
each root's **immediate children** and return those that contain a ``.planctl/``
directory. Mirrors jobctl's ``_discover_planctl_projects`` semantics —
immediate children only, **skip nested** ``.planctl/`` (agent worktrees live at
``<project>/.claude/worktrees/<id>/.planctl/`` and must not double-count).

No daemon, no devctl, no jobctl cache — planctl owns its own roots. Fail-soft: a
root that doesn't exist (or can't be listed) is skipped, not an error.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from planctl.config import load_roots


@dataclass(frozen=True)
class ResolveResult:
    """Outcome of ``resolve_epic_globally`` (fn-600).

    Cwd-then-global epic-id resolution distinguishes the three observable
    outcomes callers need to branch on without re-parsing or re-scanning:

    - **Resolved**: ``project_path`` is the owning project root and
      ``epic_path`` is the ``.planctl/epics/<id>.json`` path inside it.
      ``owners`` is empty.
    - **Not found**: id matches no project's on-disk epic. ``project_path``
      and ``epic_path`` are both ``None``. ``owners`` is empty.
    - **Ambiguous**: id appears in two or more projects (legacy dup state —
      ``_check_global_name_unique`` post-fix prevents new ones, but historical
      collisions may exist). ``project_path`` and ``epic_path`` are ``None``;
      ``owners`` lists every project carrying the id. Callers surface a
      ``dep_ambiguous_id`` error envelope.

    Hard contract: ambiguous-id is an error, not a silent pick. Do NOT follow
    ``scan_epic_ids_global``'s "last-walked wins" comment as resolver
    semantics; that's for human-readable error messages in dup-detection
    paths only.
    """

    project_path: Path | None
    epic_path: Path | None
    owners: list[Path] = field(default_factory=list)

    @property
    def resolved(self) -> bool:
        """True iff the id resolved to exactly one project."""
        return self.project_path is not None

    @property
    def ambiguous(self) -> bool:
        """True iff two or more projects carry the id."""
        return len(self.owners) > 1


def resolve_epic_globally(
    epic_id: str, roots: list[Path] | None = None
) -> ResolveResult:
    """Resolve an epic id cwd-then-global, distinguishing not-found from ambiguous.

    Resolution order mirrors ``run_approve.py::_resolve_project_for_approve``:

    1. **Cwd**: if the current working directory is a planctl project AND its
       ``.planctl/epics/<epic_id>.json`` exists, return it. This preserves the
       single-repo workflow (no configured ``roots`` required) and is also the
       canonical short-circuit when the id lives in the parent epic's own
       project — by far the common case.
    2. **Roots discovery**: scan configured (or given) ``roots`` for projects
       whose ``.planctl/epics/<epic_id>.json`` exists. Exactly one match →
       resolved. Zero → not found. Many → ambiguous (legacy dup state).

    The cwd-first short-circuit must NOT count toward the ambiguity check —
    if the id resolves locally we never look further. Callers that want the
    full multi-project view (e.g. integrity restamp building the global
    ``all_epic_ids`` set) use :func:`scan_epic_ids_global` directly.

    Fail-soft on roots discovery: if ``discover_projects()`` raises or yields
    nothing, the global step contributes no candidates — callers see a
    not-found result, never an exception. The cwd short-circuit still works
    in that degraded case (no configured ``roots``).
    """
    from planctl.project import find_project_root

    # 1. Cwd short-circuit: keeps single-repo workflows working without
    # configured roots, and is the common hot path when the dep lives in the
    # parent epic's own project.  ``find_project_root`` already swallows its
    # known failure modes (git not on PATH, not a git repo) and falls back to
    # ``Path.cwd()``; any further OSError (e.g. unreadable cwd) is the only
    # remaining failure surface here.
    cwd_root: Path | None
    try:
        cwd_root = find_project_root()
    except OSError:
        cwd_root = None
    if cwd_root is not None and (cwd_root / ".planctl").is_dir():
        cwd_epic = cwd_root / ".planctl" / "epics" / f"{epic_id}.json"
        if cwd_epic.exists():
            return ResolveResult(project_path=cwd_root, epic_path=cwd_epic)

    # 2. Roots discovery. Fail-soft: an unconfigured / unwritable / empty
    # discovery yields zero candidates, equivalent to "not found".
    try:
        matches = find_projects_with_epic(epic_id, roots)
    except Exception:
        matches = []

    # Filter the cwd path out of the candidates so we don't double-count it as
    # ambiguous when both cwd and discovery surface the same project (e.g.
    # cwd is itself under a configured root but its on-disk epic JSON was
    # absent above, which would only happen on a freshly-deleted file race —
    # belt-and-suspenders).
    if cwd_root is not None:
        try:
            cwd_real = cwd_root.resolve()
        except Exception:
            cwd_real = cwd_root
        matches = [m for m in matches if m.resolve() != cwd_real]

    if not matches:
        return ResolveResult(project_path=None, epic_path=None)
    if len(matches) == 1:
        owner = matches[0]
        return ResolveResult(
            project_path=owner,
            epic_path=owner / ".planctl" / "epics" / f"{epic_id}.json",
        )

    # Ambiguous: legacy dup state. Callers surface dep_ambiguous_id; the
    # resolver does NOT silently pick a winner.
    return ResolveResult(project_path=None, epic_path=None, owners=list(matches))


def find_projects_with_task(
    task_id: str, roots: list[Path] | None = None
) -> list[Path]:
    """Return discovered project roots whose ``.planctl/tasks/<task_id>.json`` exists.

    Scans the configured (or given) ``roots`` via :func:`discover_projects`, then
    filters to those holding the named task definition on disk. Used by ``claim``
    to resolve a task's owning project cwd-agnostically (fn-542 task .3).

    Returns absolute, deduplicated, sorted project roots (inherits the ordering
    guarantees of :func:`discover_projects`). Empty list when no project holds
    the task — the caller maps that to ``TASK_NOT_FOUND``.
    """
    matches: list[Path] = []
    for project in discover_projects(roots):
        if (project / ".planctl" / "tasks" / f"{task_id}.json").exists():
            matches.append(project)
    return matches


def find_projects_with_epic(
    epic_id: str, roots: list[Path] | None = None
) -> list[Path]:
    """Return discovered project roots whose ``.planctl/epics/<epic_id>.json`` exists.

    Sibling of :func:`find_projects_with_task` for epic-keyed lookups. Used by
    ``approve`` to resolve an epic's owning project cwd-agnostically when the
    operator invokes ``planctl approve <epic_id> ...`` from outside the repo
    whose ``.planctl/`` holds the epic.
    """
    matches: list[Path] = []
    for project in discover_projects(roots):
        if (project / ".planctl" / "epics" / f"{epic_id}.json").exists():
            matches.append(project)
    return matches


def discover_projects(roots: list[Path] | None = None) -> list[Path]:
    """Return planctl project directories under the given (or configured) roots.

    A project is an **immediate child** of a root that contains a ``.planctl/``
    directory. Nested ``.planctl/`` dirs (worktrees, vendored copies, archived
    snapshots) are intentionally NOT surfaced — only one level of children is
    scanned per root.

    Roots are deduplicated and missing / unlistable roots are skipped silently.
    Returned paths are absolute and deduplicated, sorted for determinism.
    """
    if roots is None:
        roots = load_roots()

    projects: list[Path] = []
    seen: set[str] = set()
    seen_roots: set[str] = set()

    for root in roots:
        root_key = str(root)
        if root_key in seen_roots:
            continue
        seen_roots.add(root_key)

        try:
            children = sorted(root.iterdir())
        except OSError:
            # Root doesn't exist or can't be listed — skip, not an error.
            continue

        for child in children:
            try:
                if not child.is_dir():
                    continue
                if not (child / ".planctl").is_dir():
                    continue
            except OSError:
                continue
            key = str(child)
            if key in seen:
                continue
            seen.add(key)
            projects.append(child)

    return sorted(projects)
