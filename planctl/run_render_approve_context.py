"""planctl render-approve-context — emit the byte-for-byte markdown contract
the ``/plan:approve`` LLM-as-judge cascade matches on (Python port of the
legacy bun approve-render script, since deleted).

Pure-render verb: takes an epic id or task id, walks the keeper projection
through ``keeper.api.get_epic`` / ``get_job``, picks the freshest target job,
reads its transcript JSONL file, and emits the marker-bearing markdown
document the ``/plan:approve`` SKILL.md body parses.

The verb is format-free — emits raw markdown via ``sys.stdout.write`` (no
``output.emit()``, no JSON envelope, no trailing ``planctl_invocation`` line)
and lives in ``cli._NO_TRACK_COMMANDS`` so the invocation decorator does not
append an NDJSON line that would corrupt the document's marker contract.

**Marker / exit contract (byte-for-byte faithful to the TS predecessor; the
SKILL.md cascade matches these literally).**

* ``KeeperDBMissing`` / ``KeeperSchemaError`` / any ``KeeperError`` raised on
  read → emit ``## ERROR: keeperd unavailable`` + kv table, exit 0.  Why exit
  0: the skill body is the policy layer, it rejects on the heading.  Exiting
  non-zero would race the rejection with a generic "render failed" branch.
* ``transcript_path`` NULL, the file unreadable
  (``OSError`` / ``UnicodeDecodeError``), or every turn filtered out → emit
  ``## ERROR: no readable final message`` OUTSIDE the BEGIN/END delimiters,
  exit 0.  Same rationale.
* Epic not found in projection, OR no eligible target job → exit non-zero
  with a clear stderr message.  The skill body cannot judge an id that has
  no associated lifecycle.

**Security — transcript-body sanitization (intentional divergence from the
TS predecessor).** Before wrapping the body in
``--- BEGIN TRANSCRIPT ---`` / ``--- END TRANSCRIPT ---``, any literal
occurrence of EITHER delimiter inside the body is neutralized (replaced with
a marker-prefixed sentinel).  A worker therefore cannot terminate the
evidence block early and inject verdict-directed prose into the region the
skill body parses for the verdict.  The BEGIN/END marker strings themselves
stay fixed (no SKILL.md change required).

**Assistant-only acceptance (fn-670).** ``extract_last_assistant_message``
walks the transcript in reverse and accepts ONLY assistant-role text turns
— user turns (interruption markers like ``[Request interrupted by user]``,
``<task-notification>`` injections that keeper writes as user turns, and
human prompts) are structurally dropped without text matching.  Earlier
revisions accepted user OR assistant and skipped ``<task-notification>`` by
text prefix; that path could surface an interrupt marker as the agent's
final message and false-reject correct work.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

# Begin/end delimiters for the transcript-injection guard.  Match the TS
# predecessor byte-for-byte — the ``/plan:approve`` skill body's marker match
# is literal, any drift breaks fail-closed judging.
TRANSCRIPT_BEGIN = "--- BEGIN TRANSCRIPT ---"
TRANSCRIPT_END = "--- END TRANSCRIPT ---"

# Replacement tokens for delimiter occurrences inside the transcript body.
# A prefix marker keeps the body human-readable (a human reading the gist
# mirror sees the replacement and understands what happened) while preventing
# the body from terminating the evidence block early.
_BEGIN_SANITIZED = "[SANITIZED BEGIN TRANSCRIPT]"
_END_SANITIZED = "[SANITIZED END TRANSCRIPT]"


# ---------------------------------------------------------------------------
# Pure helpers (testable in isolation)
# ---------------------------------------------------------------------------


def pick_target_job(
    id_str: str,
    epic_jobs: list[dict[str, Any]],
    epic_tasks: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """Pick the target_job for *id_str* from an epic's embedded jobs.

    * For a TASK id: walk ``epic_tasks`` for the element whose ``task_id``
      matches, filter to NON-``approve`` entries in its ``jobs[]``, then
      PREFER the job carrying the greatest ``last_commit_for_task_at`` —
      the server-stamped link to the session that actually committed work
      for this task (keeper git-worker parses the ``Task:`` trailer and
      coalesces ``Job-Id:`` into a session id, then ``foldCommit`` stamps
      the unix-seconds timestamp onto the matching embedded job element).
      Fall back to the freshest ``created_at`` (the planctl ``claim`` time)
      ONLY when no embedded job carries the link (task worked-but-not-
      committed, or pre-v49 keeper data).  An ``approve`` session judges
      the task — it is never itself a judge *target*.  Including it lets
      a re-run resolve to the previous approve session and read its own
      verdict line back (which carries reject tokens like ``please
      clarify``), a self-reinforcing reject loop that shadows the
      worker's real final message.
    * For an EPIC id: prefer jobs whose ``plan_verb`` is ``close`` or
      ``work``; fall back to any embedded job.  EPIC ids use the
      freshest-``created_at`` pick — the per-task commit link does not
      apply at the epic level.

    Returns ``None`` if no eligible job exists.  Defensive on
    missing/non-numeric ``last_commit_for_task_at`` (treated as absent,
    mirrored ``-inf`` guard on ``created_at``).
    """
    from planctl.ids import is_task_id

    if is_task_id(id_str):
        candidates: list[dict[str, Any]] = []
        for task_row in epic_tasks:
            if task_row.get("task_id") == id_str:
                jobs = task_row.get("jobs")
                if isinstance(jobs, list):
                    candidates = [
                        j
                        for j in jobs
                        if isinstance(j, dict) and j.get("plan_verb") != "approve"
                    ]
                break

        if not candidates:
            return None

        # Prefer the committing-session link when ANY candidate carries it.
        # The link is server-stamped (keeper foldCommit v49) — task work that
        # never produced a commit-with-Task-trailer leaves the field absent
        # on every embedded job, in which case we degrade to freshest-claim.
        def _commit_ts(job: dict[str, Any]) -> float:
            v = job.get("last_commit_for_task_at")
            if isinstance(v, (int, float)):
                return float(v)
            return float("-inf")

        if any(_commit_ts(j) != float("-inf") for j in candidates):
            return max(candidates, key=_commit_ts)
        # Fallthrough: no candidate carries the link — freshest-claim wins.
    else:
        all_jobs = [j for j in epic_jobs if isinstance(j, dict)]
        verbed = [j for j in all_jobs if j.get("plan_verb") in ("close", "work")]
        candidates = verbed if verbed else all_jobs

        if not candidates:
            return None

    # Defensive max — treat missing/non-numeric ``created_at`` as -inf so a
    # malformed embedded row never wins a tie against a real one.
    def _ts(job: dict[str, Any]) -> float:
        v = job.get("created_at")
        if isinstance(v, (int, float)):
            return float(v)
        return float("-inf")

    return max(candidates, key=_ts)


def extract_last_assistant_message(jsonl: str) -> str | None:
    """Extract the last assistant-role text turn from a transcript JSONL string.

    Assistant-only by design (fn-670): an interruption marker
    ``[Request interrupted by user]`` lands as a ``user`` turn — if we
    accepted user turns the judge would read the marker back as the worker's
    final message and reject correct work.  Restricting to assistant turns
    structurally drops three classes of noise (interrupt markers,
    ``<task-notification>`` injections — keeper writes them as user turns,
    and human prompts) without any text matching.

    * Accept turns whose ``type`` (or fallback ``message.role``) is
      ``assistant``.
    * Text blocks ONLY when ``content`` is an array — skip ``thinking`` /
      ``tool_use`` / ``tool_result`` / attachments / any other non-text
      block.  A string ``content`` is taken verbatim.
    * Join collected text blocks with ``\\n`` and strip.  Skip empties.

    Returns the first accepted turn's trimmed text on the reverse walk, or
    ``None`` if the walk completes without a match.
    """
    lines = jsonl.split("\n")
    for raw in reversed(lines):
        stripped = raw.strip()
        if not stripped:
            continue
        try:
            row = json.loads(stripped)
        except (ValueError, TypeError):
            continue
        if not isinstance(row, dict):
            continue
        type_ = row.get("type")
        message = row.get("message")
        role = message.get("role") if isinstance(message, dict) else None
        is_asst = type_ == "assistant" or role == "assistant"
        if not is_asst:
            continue
        content = message.get("content") if isinstance(message, dict) else None
        text: str
        if isinstance(content, str):
            text = content.strip()
        elif isinstance(content, list):
            parts: list[str] = []
            for c in content:
                if not isinstance(c, dict):
                    continue
                if c.get("type") != "text":
                    continue
                t = c.get("text")
                if isinstance(t, str) and t:
                    parts.append(t)
            text = "\n".join(parts).strip()
        else:
            continue
        if not text:
            continue
        return text
    return None


def sanitize_transcript_body(body: str) -> str:
    """Neutralize literal BEGIN/END delimiters inside a transcript body.

    A worker cannot terminate the evidence block early and inject
    verdict-directed prose into the region the skill body parses for the
    verdict — every literal occurrence of either delimiter is replaced with
    a bracketed sentinel that is visibly NOT the marker.
    """
    return body.replace(TRANSCRIPT_END, _END_SANITIZED).replace(
        TRANSCRIPT_BEGIN, _BEGIN_SANITIZED
    )


def render_kv(rows: list[tuple[str, str]]) -> str:
    """Render the kv table at the top of the document.

    Markdown table so the section is human-readable on a gist mirror without
    losing structure; the skill body matches on heading labels, not table
    positions.  Row order is preserved verbatim from the caller — the TS
    predecessor's canonical order is the caller's responsibility.
    """
    lines = ["| key | value |", "|---|---|"]
    for k, v in rows:
        lines.append(f"| {k} | {v} |")
    return "\n".join(lines)


def render_transcript_section(body: str | None) -> str:
    """Wrap the (already-sanitized) transcript body in BEGIN/END delimiters.

    The null / blank fork is owned by :func:`render` (which emits
    :func:`render_no_readable_final_message` OUTSIDE the markers); the
    ``(no transcript content available)`` placeholder is a defense-in-depth
    fallback that should never appear in production.
    """
    inner = body if body else "(no transcript content available)"
    return "\n".join(
        [
            "## last message",
            "",
            TRANSCRIPT_BEGIN,
            inner,
            TRANSCRIPT_END,
            "",
        ]
    )


def render_no_readable_final_message(detail: str) -> str:
    """Render the no-readable-final-message section.

    Lives OUTSIDE the BEGIN/END transcript delimiters by design — the marker
    must be plain prose for the skill body to match the heading directly.
    Modeled on :func:`render_keeperd_unavailable` (title-less; the section
    heading itself is the marker the skill cascade matches on).
    """
    return "\n".join(
        [
            "## ERROR: no readable final message",
            "",
            f"Detail: {detail}",
            "",
        ]
    )


def render_keeperd_unavailable(id_str: str, kind: str, detail: str) -> str:
    """Render the keeperd-down envelope.

    Regular sections are REPLACED by a single
    ``## ERROR: keeperd unavailable`` heading so the skill body matches and
    rejects with reason ``infra: keeperd unavailable``.  We still emit the
    kv table (id + kind) so the human reading the gist mirror sees which id
    was rejected.
    """
    kv = render_kv([("id", id_str), ("kind", kind)])
    return "\n".join(
        [
            f"# planctl approve context — `{id_str}`",
            "",
            kv,
            "",
            "## ERROR: keeperd unavailable",
            "",
            f"Detail: {detail}",
            "",
        ]
    )


# ---------------------------------------------------------------------------
# Sentinel error: the spec is wrong (id doesn't resolve).  Exit non-zero.
# ---------------------------------------------------------------------------


class RenderError(Exception):
    """The caller passed an id that cannot be rendered.

    Surfaces as stderr + non-zero exit from :func:`run`; the skill body
    cannot judge an id that has no associated job lifecycle.
    """


# ---------------------------------------------------------------------------
# Main render pipeline
# ---------------------------------------------------------------------------


def _resolve_transcript_path(raw: str) -> Path:
    """Expand ``~`` and resolve a transcript path to an absolute Path.

    Defensive: the keeper projection should store absolute paths, but a
    relative or ``~``-prefixed value would otherwise surface as a false
    ``## ERROR: no readable final message`` via the read failing.
    """
    return Path(raw).expanduser().resolve()


def render(id_str: str) -> str:
    """Compose the markdown document for *id_str*.

    Reads keeper data ONLY via ``keeper.api.get_epic`` / ``get_job`` —
    cli-boundary clean.  Returns the rendered string; callers route it to
    stdout.  Raises :class:`RenderError` when the id has no associated
    lifecycle; lets ``keeper.api`` exceptions propagate so the entrypoint
    can map them to the keeperd-unavailable marker.
    """
    from keeper.api import get_epic, get_job  # type: ignore[import-not-found]

    from planctl.ids import epic_id_from_task, is_epic_id, is_task_id

    if is_task_id(id_str):
        epic_id = epic_id_from_task(id_str)
        kind = "task"
    elif is_epic_id(id_str):
        epic_id = id_str
        kind = "epic"
    else:
        raise RenderError(f"invalid id: {id_str!r} (expected fn-N-slug or fn-N-slug.M)")

    epic = get_epic(epic_id)
    if epic is None:
        raise RenderError(f"epic '{epic_id}' not found in keeper projection")

    epic_jobs_raw = epic.get("jobs")
    epic_tasks_raw = epic.get("tasks")
    epic_jobs = epic_jobs_raw if isinstance(epic_jobs_raw, list) else []
    epic_tasks = epic_tasks_raw if isinstance(epic_tasks_raw, list) else []
    project_dir_raw = epic.get("project_dir")
    project_dir = project_dir_raw if isinstance(project_dir_raw, str) else None

    target_job = pick_target_job(id_str, epic_jobs, epic_tasks)
    if target_job is None:
        raise RenderError(
            f"no target_job found for '{id_str}' — the id has never been "
            "claimed or worked"
        )

    target_job_id_raw = target_job.get("job_id")
    if not isinstance(target_job_id_raw, str) or not target_job_id_raw:
        raise RenderError(
            f"embedded target job for '{id_str}' has no job_id — projection corrupt"
        )
    target_job_id = target_job_id_raw
    target_plan_verb_raw = target_job.get("plan_verb")
    target_plan_verb = (
        target_plan_verb_raw if isinstance(target_plan_verb_raw, str) else "(unknown)"
    )
    target_state_raw = target_job.get("state")
    embedded_state = target_state_raw if isinstance(target_state_raw, str) else None

    # Round-trip 2: the full job row (transcript_path + state).
    # ``get_job`` may return None when the epic embedded the job but the
    # ``jobs`` projection row has been reaped — treat as transcript
    # unreadable, NOT keeperd-down.
    job_row = get_job(target_job_id)
    transcript_path: str | None = None
    job_state = embedded_state if embedded_state is not None else "(unknown)"
    if job_row is not None:
        tp = job_row.get("transcript_path")
        if isinstance(tp, str) and tp:
            transcript_path = tp
        s = job_row.get("state")
        if isinstance(s, str) and s:
            job_state = s

    last_message: str | None = None
    transcript_read_detail: str | None = None
    if transcript_path is not None:
        try:
            body = _resolve_transcript_path(transcript_path).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            transcript_read_detail = f"transcript read failed: {exc}"
        else:
            last_message = extract_last_assistant_message(body)
            if last_message is None:
                transcript_read_detail = (
                    f"no readable assistant text turn in {transcript_path}"
                )
    elif job_row is None:
        # Job row reaped — treat as unreadable transcript (exit-0 marker), NOT
        # keeperd-down.  Surface in the detail so a human reading the gist
        # mirror knows why.
        transcript_read_detail = (
            f"jobs row for {target_job_id} not in projection "
            "(reaped or never persisted)"
        )
    else:
        transcript_read_detail = "jobs row has no transcript_path"

    kv = render_kv(
        [
            ("id", id_str),
            ("kind", kind),
            ("epic", epic_id),
            ("project_dir", project_dir if project_dir else "(unknown)"),
            ("job_id", target_job_id),
            ("plan_verb", target_plan_verb),
            ("state", job_state),
        ]
    )

    if last_message is not None and last_message:
        sanitized = sanitize_transcript_body(last_message)
        tail = render_transcript_section(sanitized)
    else:
        tail = render_no_readable_final_message(
            transcript_read_detail
            if transcript_read_detail is not None
            else "unknown failure"
        )

    return "\n".join(
        [
            f"# planctl approve context — `{id_str}`",
            "",
            kv,
            "",
            tail,
        ]
    )


# ---------------------------------------------------------------------------
# Entrypoint (registered on cli.py)
# ---------------------------------------------------------------------------


def run(args: SimpleNamespace) -> int:
    """Render the approve context for *args.id* to stdout.

    Format-free: writes raw markdown via ``sys.stdout.write``, no
    ``output.emit()``, no ``planctl_invocation`` envelope.  The verb is
    registered in ``cli._NO_TRACK_COMMANDS`` so the InvocationTrackedGroup
    decorator does NOT append a trailing NDJSON line — appending one would
    corrupt the marker contract the ``/plan:approve`` skill body matches on.
    """
    from keeper.api import KeeperError  # type: ignore[import-not-found]

    from planctl.ids import is_epic_id, is_task_id

    id_str: str = args.id

    if not is_epic_id(id_str) and not is_task_id(id_str):
        sys.stderr.write(
            f"render-approve-context: invalid id: {id_str!r} "
            "(expected fn-N-slug or fn-N-slug.M)\n"
        )
        return 1

    kind = "task" if is_task_id(id_str) else "epic"

    try:
        doc = render(id_str)
    except KeeperError as exc:
        # Daemon down / schema mismatch — emit the keeperd-unavailable marker
        # and exit 0 so the skill body matches the heading and rejects on it
        # (rather than racing with a generic "render failed" branch).
        sys.stdout.write(render_keeperd_unavailable(id_str, kind, str(exc)))
        return 0
    except RenderError as exc:
        sys.stderr.write(f"render-approve-context: {exc}\n")
        return 1

    sys.stdout.write(doc)
    return 0
