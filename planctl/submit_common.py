"""Shared plumbing for the close-phase submit verbs (audit/verdict/followup).

The three submit verbs (``planctl audit submit`` / ``verdict submit`` /
``followup submit``) all share the same skeleton: resolve the owning planctl
project (cwd-walk or ``--project``), read stdin under a 1 MiB byte cap, load the
on-disk audit brief to stamp ``commit_set_hash`` + ``schema_version`` (a typed
error when the brief is missing — the close pipeline runs ``close-preflight``
first), then persist commit-free via the task-1 :func:`write_artifact`. They are
runtime-state-only verbs (like ``claim`` / ``close-preflight``): they mutate
only gitignored ``state/audits/`` and draw NO ``.planctl/`` commit.

This module owns the bits common to all three: the byte-cap stdin reader, the
brief loader, the project resolver, and the typed error emitter. Each verb's own
``run_*`` module owns its payload validation + envelope shape.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, NoReturn

#: Same 1 MiB stdin cap scaffold uses against a YAML billion-laughs DoS. A real
#: audit report / verdict / follow-up plan is a few KB; 1 MiB is generous.
MAX_STDIN_BYTES = 1 * 1024 * 1024


def emit_submit_error(
    code: str, message: str, *, details: Any | None = None
) -> NoReturn:
    """Emit a typed submit error envelope and exit 1.

    Shape ``{"success": false, "error": {"code", "message", "details?"}}`` — the
    house single-fetch error shape (claim / close-preflight). Routes through
    ``format_output`` so ``--format yaml`` renders YAML. Sets the invocation
    sentinel so the decorator never double-emits after this terminal envelope.
    These verbs run under a ``FormattedGroup`` subgroup so the decorator never
    fires anyway, but the sentinel keeps the error path uniform with the
    top-level read-only verbs.
    """
    from planctl._util import format_output

    error: dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        error["details"] = details
    format_output({"success": False, "error": error})
    set_invocation_sentinel()
    sys.exit(1)


def set_invocation_sentinel() -> None:
    """Set INVOCATION_EMITTED_SENTINEL on the active click context (best-effort).

    No-op when there is no active click context (tests calling ``run()``
    directly). Mirrors ``run_close_preflight._set_invocation_sentinel``.
    """
    try:
        import click

        from planctl.output import INVOCATION_EMITTED_SENTINEL

        cctx = click.get_current_context()
        if cctx.obj is None:
            cctx.obj = {}
        if isinstance(cctx.obj, dict):
            cctx.obj[INVOCATION_EMITTED_SENTINEL] = True
    except RuntimeError:
        pass


def read_payload_capped(file_arg: str, *, label: str) -> str:
    """Read the payload from ``file_arg`` (or stdin on ``-``) under the byte cap.

    Reads raw bytes pre-decode so the cap counts wire bytes, not post-newline
    text — the same defense scaffold applies. ``-`` reads stdin (a TTY stdin is
    rejected; a submit verb is always piped); any other value is a file path.
    Over-cap and non-UTF-8 raise a typed ``PAYLOAD_TOO_LARGE`` / ``BAD_ENCODING``
    error; an unreadable file or TTY stdin raises ``NO_STDIN``.
    """
    if file_arg == "-":
        if sys.stdin.isatty():
            emit_submit_error(
                "NO_STDIN",
                f"stdin is a TTY — pipe the {label} on stdin (pass `--file -`)",
            )
        try:
            raw = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
        except OSError as exc:
            emit_submit_error("NO_STDIN", f"could not read {label} from stdin: {exc}")
    else:
        try:
            raw = Path(file_arg).read_bytes()
        except OSError as exc:
            emit_submit_error(
                "NO_STDIN", f"could not read {label} file {file_arg}: {exc}"
            )
    if len(raw) > MAX_STDIN_BYTES:
        emit_submit_error(
            "PAYLOAD_TOO_LARGE",
            f"{label} exceeds {MAX_STDIN_BYTES} bytes (got {len(raw)})",
        )
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        emit_submit_error("BAD_ENCODING", f"{label} is not valid UTF-8: {exc}")


def resolve_audit_context(epic_id: str, project: str | None):
    """Resolve the project + load the on-disk brief for *epic_id*.

    Returns ``(primary_repo, brief)`` where ``primary_repo`` is the resolved
    absolute state-repo path (from the brief, which ``close-preflight`` stamped)
    and ``brief`` is the parsed ``audits/<epic_id>/brief.json`` dict.

    Typed errors: ``BAD_EPIC_ID`` (garbage / task-shaped id), ``NOT_A_PROJECT``
    (``--project`` path has no ``.planctl/``), ``BRIEF_MISSING`` (no brief on
    disk — run ``close-preflight`` first), ``BRIEF_CORRUPT`` (unparseable JSON or
    a ``schema_version`` newer than this planctl knows).
    """
    import json

    from planctl.audit_artifacts import (
        AUDIT_SCHEMA_VERSION,
        ArtifactSchemaTooNewError,
        brief_path,
    )
    from planctl.ids import is_epic_id, is_task_id
    from planctl.project import ProjectContext, resolve_project

    if not is_epic_id(epic_id):
        if is_task_id(epic_id):
            parent = epic_id.rsplit(".", 1)[0]
            emit_submit_error(
                "BAD_EPIC_ID",
                f"close operates on epics, not tasks — parent epic is {parent}",
                details={"task_id": epic_id, "parent_epic": parent},
            )
        emit_submit_error("BAD_EPIC_ID", f"Invalid epic ID: {epic_id}")

    if project is not None:
        import click

        project_path_obj = Path(project).expanduser()
        if not project_path_obj.is_absolute():
            raise click.UsageError(
                f"--project requires an absolute path, got: {project}"
            )
        project_root = project_path_obj.resolve()
        if not (project_root / ".planctl").is_dir():
            emit_submit_error(
                "NOT_A_PROJECT",
                f"No planctl project found at {project_root}. Run 'planctl init' first.",
            )
        planctl_dir = project_root / ".planctl"
        ctx = ProjectContext(
            name=project_root.name,
            data_dir=planctl_dir,
            state_dir=planctl_dir / "state",
            project_path=project_root,
        )
    else:
        ctx = resolve_project()

    # The brief's primary_repo is the authoritative state repo (close-preflight
    # stamped it from epic.primary_repo). Resolve the brief path against the
    # project's own path first to FIND it, then trust the brief's value.
    bp = brief_path(ctx.project_path, epic_id)
    if not bp.exists():
        emit_submit_error(
            "BRIEF_MISSING",
            (
                f"no audit brief for {epic_id} at {bp}; "
                "run `planctl close-preflight {epic_id}` first"
            ),
            details={"expected": str(bp)},
        )
    try:
        brief = json.loads(bp.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        emit_submit_error("BRIEF_CORRUPT", f"could not read brief {bp}: {exc}")

    found_version = brief.get("schema_version")
    if isinstance(found_version, int) and found_version > AUDIT_SCHEMA_VERSION:
        exc = ArtifactSchemaTooNewError(found_version)
        emit_submit_error(
            "BRIEF_CORRUPT",
            str(exc),
            details={"found": exc.found, "known": exc.known},
        )

    primary_repo = str(Path(brief.get("primary_repo") or ctx.project_path).resolve())
    return primary_repo, brief


__all__ = (
    "MAX_STDIN_BYTES",
    "emit_submit_error",
    "set_invocation_sentinel",
    "read_payload_capped",
    "resolve_audit_context",
)
