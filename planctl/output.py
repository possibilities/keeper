"""Output helpers for planctl — wraps format_output with the {success, ...} envelope."""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from typing import NoReturn


# Sentinel key set on click ctx.obj when ``emit()`` writes a mutating
# ``planctl_invocation`` envelope. ``InvocationTrackedGroup.invoke`` in
# ``planctl/cli.py`` reads this after the verb returns; absence means the verb
# was read-only and the decorator must emit its own read-only envelope.
INVOCATION_EMITTED_SENTINEL = "_planctl_invocation_emitted"


def emit(
    data: dict,
    *,
    text_renderer: Callable[[dict], str] | None = None,
    planctl_invocation: dict | None = None,
    verb: str | None = None,
    target: str | None = None,
    detail: str | None = None,
    repo_root: Path | None = None,
    primary_repo: str | None = None,
    queue_jump: bool = False,
) -> None:
    """Emit {"success": true, **data} to stdout in the ambient --format.

    Parameters
    ----------
    data:
        Payload merged into the success envelope.
    text_renderer:
        Optional callable for ``--format human`` output.  Receives the full
        envelope dict and returns a string.  When None or raises, human format
        falls back to JSON.
    planctl_invocation:
        Pre-built ``planctl_invocation`` envelope payload. Callers that still
        construct the payload themselves pass it here; ``emit()`` injects it
        under the ``planctl_invocation`` key in the envelope and runs the
        per-verb auto-commit against it. When present, the envelope is emitted
        as compact single-line JSON (NDJSON) regardless of ``--format``. Mutual
        exclusive with the *verb* parameter — pass one or the other.
    verb / target / detail / repo_root / primary_repo / queue_jump:
        central seam: when *verb* is passed (mutating-verb path), ``emit()``
        builds the ``planctl_invocation`` payload itself by invoking
        :func:`planctl.invocation.build_planctl_invocation`, then runs the
        per-verb auto-commit against it. Required when *planctl_invocation*
        is not pre-built. There is no seam-level write-tree unwind: the three
        multi-file mint verbs (``scaffold``, ``refine-apply``, ``epic
        create``) own their own local write-phase unwind for a mid-write
        crash; a pre-commit raise here surfaces verbatim and leaves any
        written files in place (the keeper HEAD-gate is the sole
        observability guard, so an untracked tree is never dispatched).
    """
    import click

    from planctl._util import format_output

    envelope: dict = {"success": True, **data}

    # ------------------------------------------------------------------
    # Resolve planctl_invocation: caller pre-built it OR build it here.
    # ------------------------------------------------------------------
    # The central seam: callers passing *verb* hand the invocation build INTO
    # emit() so the same code path that runs the commit also owns the
    # invocation build. The build runs BEFORE the auto-commit. A raise here
    # surfaces verbatim to the CLI layer — there is no seam-level unwind; the
    # multi-file mint verbs own their own local write-phase unwind for a
    # mid-write crash, and the keeper HEAD-gate keeps any pre-commit tree
    # invisible to the autopilot.
    if planctl_invocation is None and verb is not None:
        if repo_root is None:
            raise TypeError("emit(verb=...) requires repo_root=")
        if target is None:
            raise TypeError("emit(verb=...) requires target=")
        from planctl.invocation import build_planctl_invocation

        planctl_invocation = build_planctl_invocation(
            verb,
            target,
            detail,
            repo_root=repo_root,
            primary_repo=primary_repo,
            queue_jump=queue_jump,
        )

    if planctl_invocation is not None:
        # Per-verb auto-commit. Runs BEFORE the success envelope prints, so an
        # envelope ``success: true`` on stdout is the authoritative signal that
        # the ``.planctl/`` commit landed. On any hard commit failure, emit a
        # structured failure envelope to stdout and exit 1 — the success
        # envelope is NOT printed. Replaced the seven-seam ``planctl
        # commit-plan`` model (fn-488) — every mutating verb now owns its
        # own commit at the verb boundary.
        try:
            from planctl import commit as _commit_mod

            _commit_mod.auto_commit_from_invocation(planctl_invocation)
        except _commit_mod.CommitFailed as exc:
            # Commit failure: a git status/add/commit error, or
            # ``commit_contended`` on bounded-retry exhaustion. The commit did
            # not land — emit the structured failure envelope and exit 1. No
            # write-tree unwind: any files written by a multi-file mint verb
            # stay on disk (§10 no-rollback), invisible to the autopilot until
            # they reach HEAD via the keeper HEAD-gate.
            failure: dict = {
                "success": False,
                "error": "commit_failed",
                "details": {
                    "error": exc.error,
                    "message": exc.message,
                    **exc.extra,
                },
                "planctl_invocation": planctl_invocation,
            }
            print(json.dumps(failure, separators=(",", ":")), flush=True)
            # Set the sentinel so the click decorator doesn't fire a trailing
            # read-only invocation line on top of the failure envelope.
            try:
                ctx = click.get_current_context()
                if ctx.obj is None:
                    ctx.obj = {}
                if isinstance(ctx.obj, dict):
                    ctx.obj[INVOCATION_EMITTED_SENTINEL] = True
            except RuntimeError:
                pass
            sys.exit(1)

        envelope["planctl_invocation"] = planctl_invocation
        # Mutating verbs emit compact single-line JSON (NDJSON) so hooks can
        # parse chained Bash calls line-by-line.
        print(json.dumps(envelope, separators=(",", ":")), flush=True)
        # Set sentinel so the click decorator knows not to double-emit.
        try:
            ctx = click.get_current_context()
            if ctx.obj is None:
                ctx.obj = {}
            if isinstance(ctx.obj, dict):
                ctx.obj[INVOCATION_EMITTED_SENTINEL] = True
        except RuntimeError:
            pass  # No active click context (e.g. in tests calling run() directly)
    else:
        format_output(envelope, text_renderer=text_renderer)


def emit_error(msg: str, *, code: int = 1) -> NoReturn:
    """Emit {"success": false, "error": msg} to stdout and exit with *code*.

    Error output always uses format_output so --format yaml renders YAML.
    Human format falls back to JSON (no text_renderer for errors).
    """
    from planctl._util import format_output

    format_output({"success": False, "error": msg})
    sys.exit(code)
