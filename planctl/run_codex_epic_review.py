"""planctl codex epic-review - Run a three-phase spec-compliance review via Codex CLI."""

from __future__ import annotations

from types import SimpleNamespace

# Module-level imports of git helpers so tests can monkeypatch them via
# "planctl.run_codex_epic_review._git_diff" etc.
from planctl.run_codex_work_review import (
    _earliest_commit,
    _git_diff,
    _git_log_first_after,
)


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
        build_epic_review_prompt,
        build_rereview_preamble,
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

    epic_id: str = args.epic_id
    base_sha: str | None = getattr(args, "base", None)
    sandbox_arg: str = getattr(args, "sandbox", "auto")
    receipt_path: str | None = getattr(args, "receipt", None)
    model: str | None = getattr(args, "model", None)

    # --- Validate input: reject task ids (epic-review is epic-only) ---
    if is_task_id(epic_id):
        emit_error(
            f"epic-review operates on epics only; got task id: {epic_id}. "
            "Use /plan:review-work for task-level review."
        )
    if not is_epic_id(epic_id):
        emit_error(f"Invalid epic ID: {epic_id}")

    ctx = resolve_project()
    data_dir = ctx.data_dir
    state_store = LocalFileStateStore(ctx.state_dir)

    # --- Determine receipt path default ---
    if receipt_path is None:
        receipt_path = f"/tmp/epic-review-receipt-{epic_id}.json"

    # --- Derive base SHA ---
    if base_sha:
        resolved_base = base_sha
    else:
        # Epic mode: union of evidence.commits across all tasks
        tasks_dir = data_dir / "tasks"
        all_commits: list[str] = []
        task_files = (
            list(tasks_dir.glob(f"{epic_id}.*.json")) if tasks_dir.exists() else []
        )

        if not task_files:
            emit_error(f"Epic {epic_id} has no tasks; cannot derive base commit.")

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
            epic_path = data_dir / "epics" / f"{epic_id}.json"
            epic_def = load_json_safe(epic_path) or {}
            created_at = epic_def.get("created_at")
            if not created_at:
                emit_error(
                    f"Epic {epic_id} has no task evidence.commits and no created_at; "
                    "cannot derive base commit. Pass --base <sha> explicitly."
                )
            resolved_base = _git_log_first_after(created_at)
            if not resolved_base:
                emit_error(
                    f"Epic {epic_id} has no task evidence.commits and no commits after "
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

    epic_spec_path = specs_dir / f"{epic_id}.md"
    if not epic_spec_path.exists():
        emit_error(f"Epic spec not found: {epic_spec_path}")
    epic_spec = epic_spec_path.read_text(encoding="utf-8")

    task_specs_parts: list[str] = []
    for task_file in sorted(specs_dir.glob(f"{epic_id}.*.md")):
        task_specs_parts.append(
            f"### {task_file.stem}\n\n{task_file.read_text(encoding='utf-8')}"
        )
    task_specs = "\n\n---\n\n".join(task_specs_parts) if task_specs_parts else ""

    # --- Build prompt ---
    prompt = build_epic_review_prompt(epic_id, epic_spec, task_specs, diff_text)

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
        "type": "epic_review",
        "id": epic_id,
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
            "type": "epic_review",
            "id": epic_id,
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
