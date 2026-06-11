"""Emit a typed resume envelope + freshly-baked brief for a dropped worker task.

``worker resume`` is the resume entrypoint for the content-blind orchestrator.
It is content-blind itself: it never inlines spec prose into the envelope.
Instead it REGENERATES the out-of-band brief fresh (bake-fresh-on-each-entrypoint)
via :func:`planctl.brief.assemble_brief` / :func:`planctl.brief.write_brief`,
returns a ``brief_ref`` handle, and a one-line process ``nudge``. The respawned
worker reads ``BRIEF_REF`` itself and finishes commit-then-done.

Runtime-state-only / readonly — regenerating the brief lands it under gitignored
``state/briefs/``; no ``.planctl/`` commit fires.
"""

from __future__ import annotations

import subprocess
from types import SimpleNamespace


def _read_git_state() -> str:
    """Capture git status + diff stat once. Returns empty string if git unavailable."""
    parts = []
    for argv in (
        ["git", "status", "--short"],
        ["git", "diff", "HEAD", "--stat"],
    ):
        try:
            result = subprocess.run(
                argv,
                check=False,
                capture_output=True,
                text=True,
            )
            out = result.stdout.strip()
            if out:
                parts.append(out)
        except FileNotFoundError:
            pass
    return "\n".join(parts)


def _find_source_commit_sha(task_id: str) -> str | None:
    """Return the short sha of the task's source commit, or ``None`` if none.

    Cheap local lookup: ``git log`` for the ``Task: <task_id>`` trailer the
    worker contract stamps on every source commit. No keeper shell-out — a
    resume must work even when keeper is unavailable. Any git failure (missing
    binary, not a repo) yields ``None`` rather than raising.
    """
    try:
        result = subprocess.run(
            [
                "git",
                "log",
                "-1",
                "--format=%h",
                f"--grep=Task: {task_id}",
                "--fixed-strings",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        return None
    if result.returncode != 0:
        return None
    sha = result.stdout.strip()
    return sha or None


def run(args: SimpleNamespace) -> int:
    import json

    from planctl.brief import assemble_brief, write_brief
    from planctl.ids import is_task_id
    from planctl.models import merge_task_state, worker_agent_for_tier
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.runtime_status import _expected_worker_cwd
    from planctl.store import LocalFileStateStore
    from pathlib import Path

    task_id: str = args.task_id

    if not is_task_id(task_id):
        emit_error(f"Invalid task id: {task_id!r}")

    ctx = resolve_project()
    data_dir = ctx.data_dir

    spec_path = data_dir / "specs" / f"{task_id}.md"
    if not spec_path.exists():
        emit_error(f"Task spec not found: {task_id}")

    # Read task status + tier. Under the commit-then-done worker contract, `done`
    # is the last thing the worker fires — observing `done` here means the source
    # commit already landed. The respawned worker just needs to verify and call
    # `planctl done` (idempotent re-call is fine).
    task_path = data_dir / "tasks" / f"{task_id}.json"
    status = "unknown"
    tier = None
    epic_id = task_id.rsplit(".", 1)[0] if "." in task_id else task_id
    state_store = LocalFileStateStore(ctx.state_dir)
    task_def: dict = {}
    if task_path.exists():
        try:
            task_def = json.loads(task_path.read_text(encoding="utf-8"))
            runtime = state_store.load_runtime(task_id)
            merged = merge_task_state(task_def, runtime)
            status = merged.get("status", "unknown")
            epic_id = merged.get("epic", epic_id)
            tier = merged.get("tier")
        except Exception:
            task_def = {}

    # Resolve repos exactly as `claim` does so the cold-resume spawn prompt is
    # byte-uniform with the claim-path prompt: target_repo via the three-level
    # fallback, primary_repo via epic.primary_repo → project_path.
    epic_def: dict = {}
    epic_path = data_dir / "epics" / f"{epic_id}.json"
    if epic_path.exists():
        try:
            epic_def = json.loads(epic_path.read_text(encoding="utf-8"))
        except Exception:
            epic_def = {}

    proj_path = str(ctx.project_path)
    target_repo = str(
        Path(_expected_worker_cwd(task_def, epic_def, proj_path)).resolve()
    )
    primary_repo = str(Path(epic_def.get("primary_repo") or proj_path).resolve())
    state_repo = primary_repo

    # --- Regenerate the brief fresh (bake-fresh-on-each-entrypoint) ---
    # `worker resume` always overwrites: it never reads a foreign brief, so the
    # reader-side schema_version gate is moot here.
    brief_dict = assemble_brief(
        task_id=task_id,
        epic_id=epic_id,
        target_repo=target_repo,
        primary_repo=primary_repo,
        state_repo=state_repo,
        tier=tier,
        data_dir=data_dir,
    )

    briefs_dir = ctx.state_dir / "briefs"
    try:
        brief_ref = str(write_brief(briefs_dir, task_id, brief_dict))
    except OSError as exc:
        emit_error(f"failed to write brief for {task_id}: {exc}")

    # Cheap process facts for the nudge.
    source_commit_sha = _find_source_commit_sha(task_id)
    git_state = _read_git_state()
    dirty_session_file_count = (
        len([ln for ln in git_state.splitlines() if ln.strip()]) if git_state else 0
    )

    nudge = (
        f"Resume task {task_id}. status={status} "
        f"source_commit={source_commit_sha or 'null'} "
        f"dirty_session_files={dirty_session_file_count}. "
        "Read BRIEF_REF, finish commit-then-done."
    )

    # Stderr notes always emit (independent of format) to inform the human
    # without cluttering the JSON/YAML stdout envelope.
    import click

    if status not in ("in_progress", "unknown"):
        click.echo(
            f"Note: task {task_id} status is {status!r} (not in_progress)",
            err=True,
        )
    click.echo(
        f"Note: task {task_id} tier is {tier!r}",
        err=True,
    )

    # Re-mark this session as working the task (guard contract). Success-path
    # only — typed-error paths above (emit_error) exit before reaching here.
    # Fail-open: no-op when CLAUDE_CODE_SESSION_ID is unset.
    from planctl.session_markers import write_work_marker

    write_work_marker(task_id)

    emit(
        {
            "task_id": task_id,
            "status": status,
            "tier": tier,
            "worker_agent": worker_agent_for_tier(tier),
            "brief_ref": brief_ref,
            "nudge": nudge,
            "target_repo": target_repo,
            "primary_repo": primary_repo,
            "source_commit_sha": source_commit_sha,
            "dirty_session_file_count": dirty_session_file_count,
        }
    )
    return 0
