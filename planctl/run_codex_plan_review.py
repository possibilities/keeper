"""planctl codex plan-review - Run a Carmack-criteria plan review via Codex CLI."""

from __future__ import annotations

from types import SimpleNamespace


def _render_human(data: dict) -> str:
    lines = [data.get("review", "")]
    lines.append("")
    lines.append(f"VERDICT={data.get('verdict') or 'UNKNOWN'}")
    lines.append(f"Receipt: {data.get('receipt_path')}")
    return "\n".join(lines)


def run(args: SimpleNamespace) -> int:
    from pathlib import Path

    from planctl.codex_review import (
        build_rereview_preamble,
        build_review_prompt,
        parse_codex_verdict,
        resolve_codex_sandbox,
        run_codex_exec,
    )
    from planctl.ids import is_epic_id, is_task_id
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.store import atomic_write_json, load_json_safe, now_iso

    epic_id: str = args.epic_id
    sandbox_arg: str = getattr(args, "sandbox", "auto")
    receipt_path: str | None = getattr(args, "receipt", None)
    model: str | None = getattr(args, "model", None)

    # Validate epic ID — reject task IDs
    if is_task_id(epic_id):
        emit_error(
            f"Expected an epic ID, got a task ID: {epic_id}. "
            "Run planctl codex plan-review on an epic, not a task."
        )
    if not is_epic_id(epic_id):
        emit_error(f"Invalid epic ID: {epic_id}")

    ctx = resolve_project()
    data_dir = ctx.data_dir
    specs_dir = data_dir / "specs"

    # Load epic spec
    epic_spec_path = specs_dir / f"{epic_id}.md"
    if not epic_spec_path.exists():
        emit_error(f"Epic spec not found: {epic_spec_path}")
    epic_spec = epic_spec_path.read_text(encoding="utf-8")

    # Load task specs for this epic
    task_specs_parts = []
    for task_file in sorted(specs_dir.glob(f"{epic_id}.*.md")):
        task_content = task_file.read_text(encoding="utf-8")
        task_specs_parts.append(f"### {task_file.stem}\n\n{task_content}")
    task_specs = "\n\n---\n\n".join(task_specs_parts) if task_specs_parts else ""

    # Build prompt
    prompt = build_review_prompt(epic_spec, task_specs)

    # Check for existing receipt (re-review path)
    default_receipt = f"/tmp/plan-review-receipt-{epic_id}.json"
    resolved_receipt = receipt_path or default_receipt

    prior_receipt = load_json_safe(Path(resolved_receipt))
    if prior_receipt and prior_receipt.get("session_id"):
        preamble = build_rereview_preamble(prior_receipt)
        prompt = preamble + prompt

    # Resolve sandbox (never pass 'auto' to codex CLI)
    try:
        sandbox = resolve_codex_sandbox(sandbox_arg)
    except ValueError as e:
        emit_error(str(e), code=2)

    # Run codex
    output, thread_id, exit_code, stderr = run_codex_exec(
        prompt, sandbox=sandbox, model=model
    )

    # Surface failures — no auto-fallback (arthack rule: fail visibly)
    if exit_code != 0:
        msg = (stderr or output or "codex exec failed").strip()
        emit_error(f"codex exec failed: {msg}", code=2)

    # Parse verdict
    verdict = parse_codex_verdict(output)

    # Write receipt (always — even for null verdict)
    receipt_data = {
        "type": "plan_review",
        "id": epic_id,
        "mode": "codex",
        "verdict": verdict,
        "session_id": thread_id,
        "timestamp": now_iso(),
        "review": output,
    }
    atomic_write_json(Path(resolved_receipt), receipt_data)

    emit(
        {
            "type": "plan_review",
            "id": epic_id,
            "verdict": verdict,
            "session_id": thread_id,
            "mode": "codex",
            "review": output,
            "receipt_path": resolved_receipt,
        },
        text_renderer=_render_human,
    )
    return 0
