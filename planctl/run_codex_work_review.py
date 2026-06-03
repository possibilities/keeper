"""planctl codex work-review - Run a Carmack-criteria implementation review via Codex CLI."""

from __future__ import annotations

import subprocess
from types import SimpleNamespace


def _git_log_first_after(timestamp: str) -> str | None:
    """Return SHA of first commit on current branch strictly after timestamp.

    Uses `git log --after=<timestamp>` and returns the oldest (last in list).
    Returns None if no commits found.
    """
    try:
        result = subprocess.run(
            [
                "git",
                "log",
                f"--after={timestamp}",
                "--format=%H",
                "--reverse",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        if lines:
            return lines[0]
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def _git_diff(base: str) -> str:
    """Return output of `git diff <base>..HEAD`."""
    result = subprocess.run(
        ["git", "diff", f"{base}..HEAD"],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout


def _earliest_commit(commits: list[str]) -> str | None:
    """Return the earliest commit SHA from a list by walking git log order.

    Iterates git log oldest-first and returns first match.
    """
    if not commits:
        return None
    commit_set = set(commits)
    try:
        result = subprocess.run(
            ["git", "log", "--format=%H", "--reverse"],
            capture_output=True,
            text=True,
            check=False,
        )
        for line in result.stdout.splitlines():
            sha = line.strip()
            if sha in commit_set:
                return sha
    except (OSError, subprocess.SubprocessError):
        pass
    # Fallback: return first in provided list
    return commits[0]


def _render_human(data: dict) -> str:
    lines = [data.get("review", "")]
    lines.append("")
    lines.append(f"VERDICT={data.get('verdict') or 'UNKNOWN'}")
    lines.append(f"Base: {data.get('base')}")
    lines.append(f"Receipt: {data.get('receipt_path')}")
    return "\n".join(lines)


def run(args: SimpleNamespace) -> int:
    from pathlib import Path

    import click

    from planctl.codex_review import (
        build_rereview_preamble,
        build_work_review_prompt,
        parse_codex_verdict,
        resolve_codex_sandbox,
        run_codex_exec,
    )
    from planctl.ids import is_epic_id, is_task_id
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.store import (
        LocalFileStateStore,
        atomic_write_json,
        load_json_safe,
        now_iso,
    )

    id_arg: str | None = getattr(args, "id", None)
    base_sha: str | None = getattr(args, "base", None)
    sandbox_arg: str = getattr(args, "sandbox", "auto")
    receipt_path: str | None = getattr(args, "receipt", None)
    model: str | None = getattr(args, "model", None)

    # --- Validate input shape ---
    if not id_arg and not base_sha:
        emit_error(
            "Must provide an id (task or epic) or --base <sha>. "
            "Example: planctl codex work-review fn-N-slug.M  "
            "or: planctl codex work-review --base <sha>"
        )

    if id_arg and not is_task_id(id_arg) and not is_epic_id(id_arg):
        emit_error(f"Invalid id (expected task id or epic id): {id_arg}")

    ctx = resolve_project()
    data_dir = ctx.data_dir
    state_store = LocalFileStateStore(ctx.state_dir)

    # --- Determine receipt path default ---
    if receipt_path is None:
        if id_arg:
            receipt_path = f"/tmp/work-review-receipt-{id_arg}.json"
        else:
            receipt_path = "/tmp/work-review-receipt-branch.json"

    # --- Derive base SHA ---
    if base_sha:
        # Explicit override — use verbatim; id is only for labelling/receipt
        resolved_base = base_sha
    elif is_task_id(id_arg):
        # Task id: read evidence.commits from runtime state
        runtime = state_store.load_runtime(id_arg)
        commits = (runtime or {}).get("evidence", {}).get("commits", []) or []

        if commits:
            resolved_base = _earliest_commit(commits)
        else:
            # Fallback: first commit after claimed_at
            task_def_path = data_dir / "tasks" / f"{id_arg}.json"
            task_def = load_json_safe(task_def_path) or {}
            runtime_state = runtime or {}
            claimed_at = runtime_state.get("claimed_at") or task_def.get("claimed_at")
            if not claimed_at:
                emit_error(
                    f"Task {id_arg} has no evidence.commits and no claimed_at; "
                    "cannot derive base commit. Pass --base <sha> explicitly."
                )
            resolved_base = _git_log_first_after(claimed_at)
            if not resolved_base:
                emit_error(
                    f"Task {id_arg} has no evidence.commits and no commits after "
                    f"claimed_at={claimed_at}. No work has landed yet for this task. "
                    "Pass --base <sha> explicitly."
                )
    else:
        # Epic id: union of evidence.commits across all tasks
        tasks_dir = data_dir / "tasks"
        all_commits: list[str] = []
        task_files = (
            list(tasks_dir.glob(f"{id_arg}.*.json")) if tasks_dir.exists() else []
        )

        if not task_files:
            emit_error(f"Epic {id_arg} has no tasks; cannot derive base commit.")

        for task_file in task_files:
            td = load_json_safe(task_file)
            if not td:
                continue
            tid = td.get("id", task_file.stem)
            runtime = state_store.load_runtime(tid)
            commits = (runtime or {}).get("evidence", {}).get("commits", []) or []
            all_commits.extend(commits)

        if all_commits:
            resolved_base = _earliest_commit(all_commits)
        else:
            # Fallback: first commit after epic created_at
            epic_path = data_dir / "epics" / f"{id_arg}.json"
            epic_def = load_json_safe(epic_path) or {}
            created_at = epic_def.get("created_at")
            if not created_at:
                emit_error(
                    f"Epic {id_arg} has no task evidence.commits and no created_at; "
                    "cannot derive base commit. Pass --base <sha> explicitly."
                )
            resolved_base = _git_log_first_after(created_at)
            if not resolved_base:
                emit_error(
                    f"Epic {id_arg} has no task evidence.commits and no commits after "
                    f"created_at={created_at}. No work has landed yet for this epic. "
                    "Pass --base <sha> explicitly."
                )

    # --- Gather diff ---
    diff_text = _git_diff(resolved_base)
    diff_lines = diff_text.count("\n")
    diff_bytes = len(diff_text.encode())
    click.echo(
        f"Diff: {diff_lines} lines, {diff_bytes} bytes (base={resolved_base[:12]})",
        err=True,
    )

    if not diff_text.strip():
        emit_error(
            f"git diff {resolved_base}..HEAD produced empty output. "
            "No changes to review. Check that --base is correct."
        )

    # --- Gather spec context ---
    specs_dir = data_dir / "specs"
    spec_parts: list[str] = []
    if id_arg:
        if is_task_id(id_arg):
            # Single task spec
            spec_path = specs_dir / f"{id_arg}.md"
            if spec_path.exists():
                spec_parts.append(
                    f"### {id_arg}\n\n{spec_path.read_text(encoding='utf-8')}"
                )
            # Also include parent epic spec
            from planctl.ids import epic_id_from_task

            epic_id = epic_id_from_task(id_arg)
            epic_spec_path = specs_dir / f"{epic_id}.md"
            if epic_spec_path.exists():
                spec_parts.insert(
                    0,
                    f"### {epic_id} (epic)\n\n{epic_spec_path.read_text(encoding='utf-8')}",
                )
        else:
            # Epic: include epic spec + all task specs
            epic_spec_path = specs_dir / f"{id_arg}.md"
            if epic_spec_path.exists():
                spec_parts.append(
                    f"### {id_arg} (epic)\n\n{epic_spec_path.read_text(encoding='utf-8')}"
                )
            for task_file in sorted(specs_dir.glob(f"{id_arg}.*.md")):
                spec_parts.append(
                    f"### {task_file.stem}\n\n{task_file.read_text(encoding='utf-8')}"
                )
    spec_context = "\n\n---\n\n".join(spec_parts) if spec_parts else ""

    # --- Build prompt ---
    id_label = id_arg or f"--base {resolved_base[:12]}"
    prompt = build_work_review_prompt(id_label, diff_text, spec_context)

    # --- Check for prior receipt (re-review path) ---
    prior_receipt = load_json_safe(Path(receipt_path))
    if prior_receipt and prior_receipt.get("session_id"):
        preamble = build_rereview_preamble(prior_receipt)
        prompt = preamble + prompt

    # --- Resolve sandbox ---
    try:
        sandbox = resolve_codex_sandbox(sandbox_arg)
    except ValueError as e:
        emit_error(str(e), code=2)

    # --- Run codex ---
    output, thread_id, exit_code, stderr = run_codex_exec(
        prompt, sandbox=sandbox, model=model
    )

    if exit_code != 0:
        msg = (stderr or output or "codex exec failed").strip()
        emit_error(f"codex exec failed: {msg}", code=2)

    # --- Parse verdict ---
    verdict = parse_codex_verdict(output)

    # --- Write receipt ---
    receipt_data = {
        "type": "work_review",
        "id": id_arg or "",
        "base": resolved_base,
        "mode": "codex",
        "verdict": verdict,
        "session_id": thread_id,
        "timestamp": now_iso(),
        "review": output,
    }
    atomic_write_json(Path(receipt_path), receipt_data)

    emit(
        {
            "type": "work_review",
            "id": id_arg or "",
            "base": resolved_base,
            "verdict": verdict,
            "session_id": thread_id,
            "mode": "codex",
            "review": output,
            "receipt_path": receipt_path,
        },
        text_renderer=_render_human,
    )
    return 0
