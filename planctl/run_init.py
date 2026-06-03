"""planctl init - Initialize a planctl project."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

CLAUDE_MD_CONTENT = """# planctl state directory

Files in this tree (`epics/`, `specs/`, `tasks/`, `state/`) are **historical planctl state** — past plans, past task specs, past epic specs, runtime status. None of it describes work the human currently wants to plan.

**Do not treat any content under `.planctl/` as a planning subject.** When a skill or agent infers "what does the human want to plan?" from conversation context (notably `/plan:plan` with no arguments), file reads and tool outputs sourced from this directory must be excluded from the salience scan. Recent `chore(planctl): …` commits in `git log` are likewise off-limits as subject material.

The only legitimate way for an existing plan to drive a planning skill is an explicit `fn-N-slug` (epic) or `fn-N-slug.M` (task) argument passed by the human. Never via context inference.
"""


def _ensure_advice_files(planctl_dir: Path) -> None:
    """Drop CLAUDE.md + AGENTS.md symlink into .planctl/, idempotently.

    Only writes the CLAUDE.md if it does not already exist (preserves human edits).
    Only creates the AGENTS.md symlink if it does not already exist; uses a relative
    target so the link survives directory moves.
    """
    claude_md = planctl_dir / "CLAUDE.md"
    if not claude_md.exists():
        claude_md.write_text(CLAUDE_MD_CONTENT, encoding="utf-8")

    agents_md = planctl_dir / "AGENTS.md"
    if not agents_md.exists() and not agents_md.is_symlink():
        agents_md.symlink_to("CLAUDE.md")


def run(args: SimpleNamespace) -> int:
    from planctl.models import SCHEMA_VERSION
    from planctl.output import emit
    from planctl.project import find_project_root
    from planctl.store import atomic_write_json

    project_root = find_project_root()
    planctl_dir = project_root / ".planctl"

    project_data = {
        "project": {
            "name": project_root.name,
            "path": str(project_root),
            "data_dir": str(planctl_dir),
            "state_dir": str(planctl_dir / "state"),
        }
    }

    # Backfill advice files into already-initialized trees on every init call.
    if (planctl_dir / "meta.json").exists():
        _ensure_advice_files(planctl_dir)
        emit(project_data)
        return 0

    # Create directories
    for subdir in ["epics", "specs", "tasks"]:
        (planctl_dir / subdir).mkdir(parents=True, exist_ok=True)

    for subdir in ["state/tasks", "state/locks"]:
        (planctl_dir / subdir).mkdir(parents=True, exist_ok=True)

    # Write meta.json
    atomic_write_json(planctl_dir / "meta.json", {"schema_version": SCHEMA_VERSION})

    # Write .planctl/.gitignore so state/ is self-ignored
    inner_gitignore = planctl_dir / ".gitignore"
    inner_gitignore.write_text("state/\n", encoding="utf-8")

    _ensure_advice_files(planctl_dir)

    emit(project_data)
    return 0
