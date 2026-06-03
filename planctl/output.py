"""Output helpers for planctl — wraps format_output with the {success, ...} envelope."""

from __future__ import annotations

import contextlib
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


def _unwind_written_paths(written_paths: list[Path] | None) -> None:
    """Best-effort unlink of *written_paths*.

    Used by the central pre-commit seam (fn-629 task .2): any pre-commit
    raise inside ``emit()`` — invocation-build raise, lock-acquire timeout,
    git status / add / commit failure — unwinds the caller's tree so a
    failed verb leaves zero on-disk side effects, matching the fn-623
    atomicity invariant and the fn-630 scaffold pattern. Files committed
    successfully are NOT unwound (§10 no-rollback policy); the unwind stops
    at the commit boundary inside ``auto_commit_from_invocation``.
    ``missing_ok=True`` because a partial ``atomic_write*`` may have failed
    before rename, so the path may not exist.
    """
    if not written_paths:
        return
    for p in written_paths:
        with contextlib.suppress(OSError):
            p.unlink(missing_ok=True)


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
    written_paths: list[Path] | None = None,
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
        fn-629 task .2 central seam: when *verb* is passed (mutating-verb
        path), ``emit()`` builds the ``planctl_invocation`` payload itself by
        invoking :func:`planctl.invocation.build_planctl_invocation` and unwinds
        *written_paths* on any pre-commit exception (invocation build raise,
        commit lock-acquire timeout, or a git status/add/commit failure) so a
        failed verb leaves zero on-disk side effects — generalising the fn-630
        scaffold pattern across every multi-file verb that routes through the
        seam. Required when *planctl_invocation* is not pre-built.
    written_paths:
        Paths the caller wrote (atomic_write/atomic_write_json) during the
        verb's mutate phase. ``emit()`` unwinds these on any pre-commit
        failure. The unwind STOPS at the commit boundary: once
        ``auto_commit_from_invocation`` commits, files are tracked and must
        never be unlinked (§10 no-rollback policy). Optional — verbs whose
        mutate phase already owns its own unwind (or that write nothing on
        disk) pass nothing.
    """
    import click

    from planctl._util import format_output

    envelope: dict = {"success": True, **data}

    # ------------------------------------------------------------------
    # Resolve planctl_invocation: caller pre-built it OR build it here.
    # ------------------------------------------------------------------
    # fn-629 task .2 (the central seam): callers passing *verb* hand the
    # invocation build INTO emit() so the same try-block that catches a
    # commit failure also catches an invocation-build failure — generalising
    # the fn-630 scaffold pattern across every multi-file mutating verb.
    # The build runs BEFORE the auto-commit, so an invocation-build raise
    # unwinds the written tree (no orphan), and a subsequent commit-lock
    # / git failure does the same (the unwind stops AFTER the commit
    # actually lands inside auto_commit_from_invocation — files tracked
    # in HEAD are never unlinked, §10).
    if planctl_invocation is None and verb is not None:
        if repo_root is None:
            raise TypeError("emit(verb=...) requires repo_root=")
        if target is None:
            raise TypeError("emit(verb=...) requires target=")
        try:
            from planctl.invocation import build_planctl_invocation

            planctl_invocation = build_planctl_invocation(
                verb,
                target,
                detail,
                repo_root=repo_root,
                primary_repo=primary_repo,
                queue_jump=queue_jump,
            )
        except BaseException:
            # Pre-commit raise: unwind the caller's tree and re-raise so the
            # CLI layer surfaces the failure verbatim. No orphan files, no
            # advanced scan_max_epic_id — the fn-623 / fn-630 atomicity
            # invariant generalised to every seam-routed verb.
            _unwind_written_paths(written_paths)
            raise

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
            # Pre-commit failure: lock-acquire timeout OR git status/add/commit
            # failure. Either case means the commit did not land — unwind the
            # caller's tree so a failed commit leaves zero on-disk side
            # effects (fn-629 task .2 generalisation of the fn-630 pattern).
            # ``auto_commit_from_invocation`` only raises BEFORE the commit
            # actually lands; once ``_git_commit`` returns, no further failure
            # is possible inside the helper, so the unwind here is always
            # pre-commit-safe (§10 no-rollback policy preserved).
            _unwind_written_paths(written_paths)
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
