"""planctl init - Initialize a planctl project."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

CLAUDE_MD_CONTENT = """# planctl state directory

Files in this tree (`epics/`, `specs/`, `tasks/`, `state/`) are **historical planctl state** — past plans, past task specs, past epic specs, runtime status. None of it describes work the human currently wants to plan.

**Do not treat any content under `.planctl/` as a planning subject.** When a skill or agent infers "what does the human want to plan?" from conversation context (notably `/plan:plan` with no arguments), file reads and tool outputs sourced from this directory must be excluded from the salience scan. Recent `chore(planctl): …` commits in `git log` are likewise off-limits as subject material.

The only legitimate way for an existing plan to drive a planning skill is an explicit `fn-N-slug` (epic) or `fn-N-slug.M` (task) argument passed by the human. Never via context inference.
"""


def _ensure_advice_files(planctl_dir: Path, project_root: Path) -> list[str]:
    """Drop CLAUDE.md + AGENTS.md symlink into .planctl/, idempotently.

    Only writes the CLAUDE.md if it does not already exist (preserves human edits).
    Only creates the AGENTS.md symlink if it does not already exist; uses a relative
    target so the link survives directory moves.

    Returns the repo-relative POSIX paths this call actually created (a subset of
    ``.planctl/CLAUDE.md`` and ``.planctl/AGENTS.md``). The caller folds these into
    the explicit commit file list — an empty list when both already exist keeps an
    idempotent re-run from staging anything.
    """
    created: list[str] = []

    claude_md = planctl_dir / "CLAUDE.md"
    if not claude_md.exists():
        claude_md.write_text(CLAUDE_MD_CONTENT, encoding="utf-8")
        created.append(claude_md.relative_to(project_root).as_posix())

    agents_md = planctl_dir / "AGENTS.md"
    if not agents_md.exists() and not agents_md.is_symlink():
        agents_md.symlink_to("CLAUDE.md")
        created.append(agents_md.relative_to(project_root).as_posix())

    return created


def _inside_git_work_tree(project_root: Path) -> bool:
    """True when *project_root* sits inside a git work tree.

    ``init`` self-commits its bootstrap files only inside a git work tree;
    outside one (a fresh non-git ``/tmp`` dir) it writes the files and exits 0
    without a commit.
    """
    import subprocess

    result = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        cwd=project_root,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0 and result.stdout.strip() == "true"


def run(args: SimpleNamespace) -> int:
    from planctl.commit_messages import build_subject
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

    # Track the repo-relative POSIX paths this invocation actually writes, so the
    # self-commit covers exactly the bootstrap files it created and an idempotent
    # re-run (which writes nothing) stays a no-op.
    written: list[str] = []

    # Backfill advice files into already-initialized trees on every init call.
    if (planctl_dir / "meta.json").exists():
        written.extend(_ensure_advice_files(planctl_dir, project_root))
    else:
        # Fresh init: create the directory skeleton + meta.json + inner gitignore.
        for subdir in ["epics", "specs", "tasks"]:
            (planctl_dir / subdir).mkdir(parents=True, exist_ok=True)

        for subdir in ["state/tasks", "state/locks"]:
            (planctl_dir / subdir).mkdir(parents=True, exist_ok=True)

        # Write meta.json
        atomic_write_json(planctl_dir / "meta.json", {"schema_version": SCHEMA_VERSION})

        # Write .planctl/.gitignore so state/ is self-ignored
        inner_gitignore = planctl_dir / ".gitignore"
        inner_gitignore.write_text("state/\n", encoding="utf-8")

        written.append((planctl_dir / "meta.json").relative_to(project_root).as_posix())
        written.append(inner_gitignore.relative_to(project_root).as_posix())
        written.extend(_ensure_advice_files(planctl_dir, project_root))

    # Self-commit the bootstrap files when there is something to commit AND we
    # are inside a git work tree. `init` is the one mutating verb that builds
    # its own invocation payload directly — no touched-paths log, no
    # CLAUDE_CODE_SESSION_ID requirement (so it works in a fresh non-git /tmp
    # dir and in any harness regardless of the session-id env). It therefore
    # does NOT call build_planctl_invocation (the touched-paths/session-id
    # path) — the payload literal below carries no session_id key, so the
    # commit lands without a Session-Id trailer.
    if written and _inside_git_work_tree(project_root):
        payload = {
            "files": sorted(written),
            "op": "init",
            "target": project_root.name,
            "subject": build_subject("init", project_root.name),
            "touched_path_files": [],
            "repo_root": str(project_root),
            "state_repo": str(project_root),
            "queue_jump": False,
        }
        # emit() runs the auto-commit, prints the structured commit_failed
        # envelope + exits 1 on CommitFailed, and sets the dedup sentinel so the
        # InvocationTrackedGroup decorator does not also emit a read-only line.
        emit(project_data, planctl_invocation=payload)
        return 0

    # Nothing written, or not in a git work tree: the read-only emit path.
    emit(project_data)
    return 0
