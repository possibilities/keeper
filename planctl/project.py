"""In-project directory resolution."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass
class ProjectContext:
    name: str
    data_dir: Path
    state_dir: Path
    project_path: Path


def find_git_root(start: Path | None = None) -> Path | None:
    """Return the nearest ancestor of *start* (default: cwd) holding a ``.git``
    entry, or ``None`` when *start* sits outside any git work tree.

    A pure-Python parent walk that stands in for the ``git rev-parse
    --show-toplevel`` / ``--is-inside-work-tree`` subprocesses on the
    resolution hot path. ``.git`` is matched with :meth:`Path.exists` so a
    linked-worktree ``.git`` *file* counts the same as a normal ``.git``
    directory. ``GIT_DIR`` / ``GIT_WORK_TREE`` overrides are not honored —
    planctl never sets them for project-root resolution.
    """
    base = (start or Path.cwd()).resolve()
    for candidate in (base, *base.parents):
        if (candidate / ".git").exists():
            return candidate
    return None


def find_project_root() -> Path:
    """Find git repo root, falling back to cwd."""
    return find_git_root() or Path.cwd().resolve()


def resolve_project() -> ProjectContext:
    """Resolve the current directory to a ProjectContext.

    Looks for a .planctl/ directory in the project root.
    """
    from planctl.output import emit_error

    project_root = find_project_root()
    planctl_dir = project_root / ".planctl"

    if not planctl_dir.exists():
        emit_error("No planctl project found. Run 'planctl init' first.")

    return ProjectContext(
        name=project_root.name,
        data_dir=planctl_dir,
        state_dir=planctl_dir / "state",
        project_path=project_root,
    )
