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


def find_project_root() -> Path:
    """Find git repo root, falling back to cwd."""
    import subprocess

    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=True,
        )
        return Path(result.stdout.strip()).resolve()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return Path.cwd().resolve()


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
