"""Emit a ready-to-paste CONTEXT-respawn prompt for a dropped worker task."""

from __future__ import annotations

import re
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


def _extract_files_line(description_text: str) -> list[str]:
    """Extract file paths from the **Files:** line inside ## Description.

    Returns a list of path strings (may be empty if the line is missing or
    malformed).
    """
    # Match **Files:** (with optional bold variants and leading whitespace)
    # followed by a comma-separated or space-separated list on the same line.
    match = re.search(
        r"^\*{1,2}Files:\*{0,2}\s*(.+)$",
        description_text,
        flags=re.MULTILINE | re.IGNORECASE,
    )
    if not match:
        return []

    raw = match.group(1).strip()
    # Split on commas or semicolons, strip each token
    tokens = [t.strip() for t in re.split(r"[,;]+", raw)]
    return [t for t in tokens if t]


def _build_prompt(
    task_id: str,
    epic_id: str,
    files: list[str],
    git_state: str,
    files_missing: bool,
) -> str:
    """Assemble the full respawn prompt."""
    lines = []

    # --- Literal worker template (copied verbatim from SKILL.md:131-140) ---
    lines.append("Implement a planctl task.")
    lines.append("")
    lines.append(f"TASK_ID: {task_id}")
    lines.append(f"EPIC_ID: {epic_id}")
    lines.append("PLANCTL: planctl")
    lines.append("REVIEW_MODE: none")
    lines.append("")
    lines.append("Follow the phases in your agent spec exactly.")
    lines.append("")

    # --- CONTEXT preamble ---
    lines.append("CONTEXT: The previous worker invocation was cut off before it could")
    lines.append("commit and call `planctl done`. The implementation may already be")
    lines.append("complete or partially complete.")
    lines.append("")
    lines.append("Your job is to:")
    lines.append(
        "1. Verify the implementation is sound (git status shows the right files changed)"
    )
    lines.append("2. Commit the changes")
    lines.append(f"3. Call `planctl done {task_id}` to mark the task done")
    lines.append("")

    # --- Git state ---
    if git_state:
        lines.append("Git state at respawn time:")
        for gl in git_state.splitlines():
            lines.append(f"  {gl}")
        lines.append("")

    # --- Files block ---
    if files_missing:
        lines.append("Files: (could not parse **Files:** from spec — run")
        lines.append(f"  `planctl cat {task_id}` to find the expected file list)")
    else:
        lines.append("Files changed:")
        for f in files:
            lines.append(f"- {f}")

    return "\n".join(lines)


def _render_human(data: dict) -> str:
    """Render the worker-resume envelope as the raw prompt text."""
    prompt = data.get("prompt", "")
    return prompt


def run(args: SimpleNamespace) -> int:
    from planctl.ids import is_task_id
    from planctl.models import merge_task_state
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.specs import get_task_section
    from planctl.store import LocalFileStateStore

    task_id: str = args.task_id

    if not is_task_id(task_id):
        emit_error(f"Invalid task id: {task_id!r}")

    ctx = resolve_project()
    data_dir = ctx.data_dir

    spec_path = data_dir / "specs" / f"{task_id}.md"
    if not spec_path.exists():
        emit_error(f"Task spec not found: {task_id}")

    # Read task status. Under the commit-then-done worker contract, `done` is
    # the last thing the worker fires — observing `done` here means the source
    # commit already landed (the harness-dropped predecessor's trailer commit
    # is discoverable via `jobctl find-task-commit`). The respawned worker just
    # needs to verify and call `planctl done` (idempotent re-call is fine; the
    # planctl mutation hook handles state commits).
    task_path = data_dir / "tasks" / f"{task_id}.json"
    status = "unknown"
    tier = None
    epic_id = task_id.rsplit(".", 1)[0] if "." in task_id else task_id
    state_store = LocalFileStateStore(ctx.state_dir)
    if task_path.exists():
        import json

        try:
            task_def = json.loads(task_path.read_text(encoding="utf-8"))
            runtime = state_store.load_runtime(task_id)
            merged = merge_task_state(task_def, runtime)
            status = merged.get("status", "unknown")
            epic_id = merged.get("epic", epic_id)
            tier = merged.get("tier")
        except Exception:
            pass

    # Capture git state exactly once
    git_state = _read_git_state()

    # Parse **Files:** from spec
    spec_content = spec_path.read_text(encoding="utf-8")
    description_text = get_task_section(spec_content, "## Description")
    files = _extract_files_line(description_text)
    files_missing = len(files) == 0

    prompt = _build_prompt(
        task_id=task_id,
        epic_id=epic_id,
        files=files,
        git_state=git_state,
        files_missing=files_missing,
    )

    # Stderr warnings always emit (independent of format), since they inform
    # the human without cluttering the JSON/YAML stdout envelope.
    import click

    if files_missing:
        click.echo(
            f"Warning: could not parse **Files:** from spec for {task_id}",
            err=True,
        )
    if status not in ("in_progress", "unknown"):
        click.echo(
            f"Note: task {task_id} status is {status!r} (not in_progress)",
            err=True,
        )
    # fn-594: build-forward — tier is required at mint time by scaffold /
    # refine-apply, so the only null-tier records left in the wild are
    # pre-fn-594 legacy on-disk tasks. The cold-resume null-tier heuristic
    # path was deleted; keeper now fails loud on a null tier,
    # and humans remediate via `/plan:plan <epic_id>` refine. The envelope
    # still emits the raw value so the skill consumer can branch on it.
    click.echo(
        f"Note: task {task_id} tier is {tier!r}",
        err=True,
    )

    # fn-589 task .1 (item 5): surface the persisted tier on the envelope so
    # /plan:work's cold-resume can branch on it without a separate `task show`
    # round trip.  Explicit JSON null (not key-omission) when the tier was
    # never set — the skill cold-path branches on `tier is None`.
    emit(
        {
            "prompt": prompt,
            "task_id": task_id,
            "status": status,
            "tier": tier,
        },
        text_renderer=_render_human,
    )
    return 0
