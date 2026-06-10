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
      ``resolved_id`` is the full slug id of the matched epic (equal to the
      input for a slug input, the canonical slug for a number-only ``fn-N``
      input). ``owners`` is empty.
    - **Not found**: id matches no project's on-disk epic. ``project_path``,
      ``epic_path``, and ``resolved_id`` are all ``None``. ``owners`` is empty.
    - **Ambiguous**: id appears in two or more projects (legacy dup state —
      ``_check_global_name_unique`` post-fix prevents new ones, but historical
      collisions may exist). ``project_path``, ``epic_path``, and
      ``resolved_id`` are ``None``; ``owners`` lists every project carrying the
      id. Callers surface a ``dep_ambiguous_id`` error envelope.

    Hard contract: ambiguous-id is an error, not a silent pick. Do NOT follow
    ``scan_epic_ids_global``'s "last-walked wins" comment as resolver
    semantics; that's for human-readable error messages in dup-detection
    paths only.

    Number-only inputs (fn-600 follow-up): a bare ``fn-N`` (no slug) resolves
    by exact epic-integer equality via :func:`planctl.ids.parse_id` — never
    string-prefix matching, so ``fn-1`` never matches ``fn-10``. The resolver
    returns the matched epic's FULL slug id in ``resolved_id`` so the
    dep-writing path can normalize the persisted edge to canonical form.
    """

    project_path: Path | None
    epic_path: Path | None
    owners: list[Path] = field(default_factory=list)
    resolved_id: str | None = None

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

    Resolution order (shared cwd-then-roots lookup):

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
        cwd_hit = _match_epic_in_project(cwd_root, epic_id)
        if cwd_hit is not None:
            resolved_id, cwd_epic = cwd_hit
            return ResolveResult(
                project_path=cwd_root,
                epic_path=cwd_epic,
                resolved_id=resolved_id,
            )

    # 2. Roots discovery. Fail-soft: an unconfigured / unwritable / empty
    # discovery yields zero candidates, equivalent to "not found".  Each match
    # carries the project root and the matched epic's FULL slug id so a
    # number-only ``fn-N`` input normalizes to canonical form.
    try:
        matches = _find_epic_matches(epic_id, roots)
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
        matches = [m for m in matches if m[0].resolve() != cwd_real]

    if not matches:
        return ResolveResult(project_path=None, epic_path=None)
    if len(matches) == 1:
        owner, resolved_id = matches[0]
        return ResolveResult(
            project_path=owner,
            epic_path=owner / ".planctl" / "epics" / f"{resolved_id}.json",
            resolved_id=resolved_id,
        )

    # Ambiguous: legacy dup state, or a number-only ``fn-N`` whose integer
    # matches an epic in two or more projects. Callers surface
    # dep_ambiguous_id; the resolver does NOT silently pick a winner.
    return ResolveResult(
        project_path=None, epic_path=None, owners=[m[0] for m in matches]
    )


def _match_epic_in_project(project: Path, epic_id: str) -> tuple[str, Path] | None:
    """Resolve *epic_id* against one project, returning ``(full_id, epic_path)``.

    A full slug input matches its own ``.planctl/epics/<epic_id>.json`` exactly.
    A number-only ``fn-N`` input matches the epic whose parsed ``epic_num``
    equals N by integer equality (never string-prefix: ``fn-1`` does not match
    ``fn-10``). Within one project the epic integer is unique by construction,
    so at most one file matches. Returns ``None`` when nothing matches.
    """
    from planctl.ids import parse_id

    epics_dir = project / ".planctl" / "epics"

    # Full-slug (or any id that exists as an exact filename): canonical exact
    # match, no scan needed. This is the hot path for slug inputs.
    exact = epics_dir / f"{epic_id}.json"
    if exact.exists():
        return epic_id, exact

    # Number-only ``fn-N``: match by epic-integer equality. A slug input that
    # didn't exist above falls through here and finds nothing (its task_num is
    # None and no bare-number file will equal a slug), so this stays safe.
    want_epic, want_task = parse_id(epic_id)
    if want_epic is None or want_task is not None:
        return None
    # Only treat the input as number-only when it has no slug tail — a slug
    # input that simply doesn't exist must NOT match a same-number epic.
    if epic_id != f"fn-{want_epic}":
        return None
    try:
        candidates = sorted(epics_dir.glob("fn-*.json"))
    except OSError:
        return None
    for candidate in candidates:
        stem = candidate.stem
        cand_epic, cand_task = parse_id(stem)
        if cand_task is not None:
            continue
        if cand_epic == want_epic:
            return stem, candidate
    return None


def _find_epic_matches(
    epic_id: str, roots: list[Path] | None = None
) -> list[tuple[Path, str]]:
    """Return ``(project_root, full_epic_id)`` for every project matching *epic_id*.

    Sibling of :func:`find_projects_with_epic` that also carries the matched
    epic's FULL slug id, so a number-only ``fn-N`` input normalizes to canonical
    form on the write side. Matching delegates to :func:`_match_epic_in_project`
    (exact-filename for a slug, integer-equality for a bare number).
    """
    matches: list[tuple[Path, str]] = []
    for project in discover_projects(roots):
        hit = _match_epic_in_project(project, epic_id)
        if hit is not None:
            matches.append((project, hit[0]))
    return matches


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
    epic-keyed verbs (e.g. ``epic rm``) to resolve an epic's owning project
    cwd-agnostically when the operator invokes them from outside the repo
    whose ``.planctl/`` holds the epic. Accepts a number-only ``fn-N`` id
    (integer-equality match) as well as a full slug.
    """
    return [project for project, _full_id in _find_epic_matches(epic_id, roots)]


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
