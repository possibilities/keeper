"""planctl gist - Create a multifile gist for an epic and its task specs."""

from __future__ import annotations

import re
import subprocess
import tempfile
import webbrowser
from pathlib import Path
from types import SimpleNamespace


def _render_human(data: dict) -> str:
    return data.get("gist_url", "")


def run(args: SimpleNamespace) -> int:
    from planctl.ids import is_epic_id, parse_id
    from planctl.output import emit, emit_error
    from planctl.project import resolve_project
    from planctl.store import load_json, load_json_safe

    epic_id: str = args.epic_id
    public: bool = args.public
    no_open: bool = args.no_open
    description: str | None = args.description

    if not is_epic_id(epic_id):
        emit_error(f"Invalid epic ID: {epic_id}")

    ctx = resolve_project()
    data_dir = ctx.data_dir

    epic_json_path = data_dir / "epics" / f"{epic_id}.json"
    if not epic_json_path.exists():
        emit_error(f"Epic not found: {epic_id}")

    epic_spec_path = data_dir / "specs" / f"{epic_id}.md"
    if not epic_spec_path.exists():
        emit_error(f"Epic spec missing: {epic_spec_path}")

    epic_def = load_json(epic_json_path)
    epic_spec = epic_spec_path.read_text(encoding="utf-8")

    tasks_dir = data_dir / "tasks"
    specs_dir = data_dir / "specs"
    tasks: list[dict] = []
    if tasks_dir.exists():
        for f in tasks_dir.glob(f"{epic_id}.*.json"):
            td = load_json_safe(f)
            if td:
                tasks.append(td)

    def _task_num(task: dict) -> int:
        _, n = parse_id(task.get("id", ""))
        return n if n is not None else 10**9

    tasks.sort(key=_task_num)

    epic_filename = f"01-epic-{epic_id}.md"
    task_entries: list[tuple[str, dict, str]] = []
    for idx, task in enumerate(tasks, start=2):
        tid = task.get("id", "")
        safe_tid = tid.replace(".", "-")
        fname = f"{idx:02d}-{safe_tid}.md"
        task_spec_path = specs_dir / f"{tid}.md"
        if not task_spec_path.exists():
            emit_error(f"Task spec missing: {task_spec_path}")
        spec_content = task_spec_path.read_text(encoding="utf-8")
        task_entries.append((fname, task, spec_content))

    toc = _build_toc(epic_def, epic_filename, task_entries)

    file_count = 2 + len(task_entries)
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        toc_path = tmp / "00-TOC.md"
        epic_path = tmp / epic_filename
        toc_path.write_text(toc, encoding="utf-8")
        epic_path.write_text(epic_spec, encoding="utf-8")

        file_paths = [str(toc_path), str(epic_path)]
        for fname, _task, spec_content in task_entries:
            p = tmp / fname
            p.write_text(spec_content, encoding="utf-8")
            file_paths.append(str(p))

        desc = description or f"{epic_id} — {epic_def.get('title', '')}"
        cmd = ["gh", "gist", "create", "--desc", desc]
        if public:
            cmd.append("--public")
        cmd.extend(file_paths)

        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            err = (result.stderr or result.stdout).strip() or "gh gist create failed"
            emit_error(f"gh gist create failed: {err}")

        stdout_lines = [ln for ln in result.stdout.strip().splitlines() if ln.strip()]
        if not stdout_lines:
            emit_error("gh gist create returned no URL")
        gist_url = stdout_lines[-1]

    if not no_open:
        webbrowser.open(gist_url)

    emit(
        {
            "gist_url": gist_url,
            "epic_id": epic_id,
            "file_count": file_count,
            "public": public,
        },
        text_renderer=_render_human,
    )
    return 0


def _anchor(filename: str) -> str:
    """Compute the GitHub gist in-page anchor for a filename."""
    slug = re.sub(r"[^a-z0-9]+", "-", filename.lower()).strip("-")
    return f"file-{slug}"


def _build_toc(
    epic_def: dict,
    epic_filename: str,
    task_entries: list[tuple[str, dict, str]],
) -> str:
    epic_id = epic_def.get("id", "")
    title = epic_def.get("title", "")
    branch = epic_def.get("branch_name")
    epic_deps = epic_def.get("depends_on_epics") or []

    lines: list[str] = [f"# {title} — `{epic_id}`", ""]
    if branch:
        lines.append(f"- **Branch:** `{branch}`")
    if epic_deps:
        lines.append(f"- **Epic deps:** {', '.join(f'`{d}`' for d in epic_deps)}")
    lines.append(f"- **Tasks:** {len(task_entries)}")
    lines.append("")
    lines.append("## Contents")
    lines.append("")
    lines.append(f"1. [Epic spec](#{_anchor(epic_filename)})")

    if task_entries:
        lines.append("")
        lines.append("## Tasks")
        lines.append("")
        lines.append("| # | ID | Title | Deps | Priority |")
        lines.append("|---|----|-------|------|----------|")
        for i, (fname, task, _spec) in enumerate(task_entries, start=1):
            tid = task.get("id", "")
            anchor = _anchor(fname)
            t_title = task.get("title", "")
            deps = task.get("depends_on") or []
            deps_str = ", ".join(f"`{d}`" for d in deps) if deps else "—"
            pri = task.get("priority")
            pri_str = str(pri) if pri is not None else "—"
            lines.append(
                f"| {i} | [`{tid}`](#{anchor}) | {t_title} | {deps_str} | {pri_str} |"
            )

    lines.append("")
    return "\n".join(lines)
