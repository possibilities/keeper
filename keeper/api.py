"""Public API: read-only views into keeper's projections.

Eight readers; all stdlib-only and gated on
``SUPPORTED_SCHEMA_VERSIONS``:

- ``get_session_dirty_files(session_id, cwd)`` — which dirty files a
  session is on the hook for, grouped by repo.  Reads
  ``file_attributions`` for attribution, then intersects against a LIVE
  ``git status`` (not the cached ``git_status`` projection) for dirtiness.
  Consumed by ``jobctl commit-work`` and friends.
- ``get_session_titles()`` — ``{session_id: title}`` for every titled
  job.  Reads ``jobs``.  Consumed by claudectl's session search.
- ``get_session_name_history()`` — ``{session_id: [title, ...]}`` for
  every job's distinct-titles history.  Reads
  ``jobs.name_history``.  Consumed by claudectl's by-any-name session
  resolver.
- ``get_session_for_pid(pid)`` — latest session id whose ``jobs.pid``
  equals *pid*, or ``None``.  Reads ``jobs`` (the new ``idx_jobs_pid``
  index covers the lookup).  Consumed by
  ``cli_common.session_context``'s psutil ancestor walk.
- ``get_session_identity_for_pid(pid)`` — live identity of the session
  owning *pid* as ``{session_id, title, name_history}``, or ``None``.
  Reads ``jobs`` in one pid-keyed query.  Consumed by chatctl to attribute
  and resolve agents by their current title or any former name.
- ``get_latest_session()`` — most-recently-updated job's
  ``{session-id, cwd, session-name}`` (``session-name`` omitted when
  ``jobs.title`` is NULL), or ``None``.  Reads ``jobs``.  Consumed by
  ``cli_common.session_context.show_context``.
- ``get_epic(epic_id)`` — one epic row as ``dict`` (with
  ``tasks`` / ``jobs`` JSON-TEXT cells defensively decoded to lists)
  or ``None`` when the row is absent.  Reads ``epics``.  Consumed by
  ``planctl render-approve-context`` to pick a target job from the
  epic's embedded ``jobs`` / ``tasks[].jobs`` arrays.
- ``get_job(job_id)`` — one job row as ``dict`` (real columns:
  ``job_id`` / ``transcript_path`` / ``cwd`` / ``state``) or ``None``
  when the row is absent.  Reads ``jobs``.  Consumed by ``planctl
  render-approve-context`` to look up the target session's transcript
  path + cwd for the final-message read.

Attribution rule for ``get_session_dirty_files`` (mirrors the reducer's
discharge semantic): a session is on the hook for a file iff it has a
mutation row whose ``last_commit_at`` is NULL or older than
``last_mutation_at`` — editing puts you on the hook, committing what
you edited takes you off.  We additionally intersect against a LIVE
``git status`` so a file that was edited then reverted (still
undischarged, but no longer dirty) does not surface.  Dirtiness is read
live rather than from the cached ``git_status`` projection so a file
edited then committed in quick succession is never dropped by a snapshot
that hasn't caught up; an unreadable ``git status`` FAILS OPEN (keep the
file) rather than fail closed (drop it).

The import graph is stdlib-only (``sqlite3``, ``json``, ``os``,
``subprocess``, ``pathlib``) — ``commit-work`` shells out to git
repeatedly, so this module must not add cold-start weight.
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
from pathlib import Path

# keeper schema versions this reader understands.  keeper tracks its schema in
# a ``meta`` key/value row — ``SELECT value FROM meta WHERE key='schema_version'``
# — NOT ``PRAGMA user_version`` (which keeper leaves at 0).  The
# ``file_attributions`` shape this reader depends on landed in
# v31 (fn-633) — dirtiness is now verified via a live ``git status`` rather
# than the cached ``git_status`` projection, so this reader no longer reads
# that table; v32 (fn-634 ``default_visible``) is additive and doesn't touch
# it; v33 (fn-639 ``profiles``) is additive and doesn't touch it; v34
# (fn-637 ``resolved_epic_deps`` on epics) is additive and doesn't touch it;
# v35 (fn-642 ``usage``+``profiles`` rate-limit colocation) is additive and
# touches only ``usage`` / ``profiles`` (keeper-py reads neither); v36 (fn-642
# ``jobs.profile_name``) is an additive nullable column on ``jobs`` and doesn't
# touch the file-attribution shape; v37 (fn-643 ``dead_letters`` operational
# sidecar table + index) is additive and touches neither; v38 (fn-645 usage
# envelope status / subscription / error axes) adds nullable columns to
# ``usage`` only (keeper-py reads neither ``usage`` nor ``profiles``); v39
# (fn-648 git-rm/git-mv deletion attribution) bumps for the backfill +
# cursor-rewind that re-derives ``events.bash_mutation_kind`` /
# ``bash_mutation_targets`` over historical rows and re-folds the projections
# — no shape change to the file-attribution-relevant tables keeper-py reads;
# v40 (fn-652 jobs.name_history) adds a NOT NULL DEFAULT '[]' JSON-array
# column on ``jobs`` carrying the ordered distinct titles a session has
# carried — keeper-py does not read ``jobs.name_history`` (the consumer is
# claudectl via a forthcoming ``get_session_name_history()``), so the bump
# is whitelist-only with no reader logic change; v41 (fn-651 usage lift
# time + freshness) adds two nullable columns to ``usage`` only
# (``rate_limit_lifts_at TEXT`` + ``last_usage_fold_at REAL``) — keeper-py
# does not read ``usage``, so the bump is whitelist-only with no reader
# logic change; v42 (fn-662 ``''↔'default'`` directional mapping) is a
# fold-output change (the v35 rate-limit fan-out now colocates the
# default-profile annotation onto ``usage.default`` via a shared pure
# helper, fixing an invisible default-account rate limit) gated on a
# rewind-and-redrain — no shape change to any table keeper-py reads (it
# reads neither ``usage`` nor ``profiles``), so the bump is whitelist-only
# with no reader logic change; v43 (fn-661 server-side autopilot reconciler
# substrate) adds a new ``dispatch_failures`` projection table carrying
# one row per sticky ``(verb, id)`` dispatch failure — keeper-py does not
# read ``dispatch_failures`` (the reader is the thin ``keeper autopilot``
# viewer, fed via the UDS subscribe wire), so the bump is whitelist-only
# with no reader logic change; v44 (fn-664 content-aware discharge
# substrate) adds an additive nullable ``file_attributions.worktree_oid``
# column carrying the filter-correct git blob oid of each dirty file's
# worktree bytes (frozen into the ``GitSnapshot`` event payload by the
# producer's ``git hash-object --stdin-paths`` batch) — keeper-py reads
# ``file_attributions`` only for the ``session_id`` / ``file_path`` /
# ``last_mutation_at`` / ``last_commit_at`` tuple and does not project
# ``worktree_oid``, so the bump is whitelist-only with no reader logic
# change; v45 (fn-664.2 content-aware discharge gate) adds the additive
# nullable ``file_attributions.worktree_mode`` column pairing with
# ``worktree_oid`` on the discharge gate (a chmod-only dirty file with
# equal blob oid but differing mode stays attributed) — keeper-py does
# not project ``worktree_mode`` for the same reason as ``worktree_oid``,
# so the bump is whitelist-only with no reader logic change; v46 (fn-666
# planctl-file attribution) widens the ``file_attributions.source`` CHECK
# enum to include ``'planctl'`` (a row-preserving table rebuild) and
# adds the additive nullable ``events.planctl_files TEXT`` column lifted
# from the envelope's ``files`` array by ``extractPlanctlInvocation`` —
# the reducer's planctl_op fold mints ``source='planctl'`` rows for
# every named path so ``.planctl`` JSONs + specs no longer orphan.
# keeper-py reads ``file_attributions`` only for the
# ``session_id`` / ``file_path`` / ``last_mutation_at`` /
# ``last_commit_at`` tuple — it never reads ``source`` or
# ``planctl_files`` — so the bump is whitelist-only with no reader
# logic change; v47 (fn-667 persist autopilot control state) adds a new
# ``autopilot_state`` singleton projection table carrying the autopilot
# worker's paused/playing flag plus a new ``AutopilotPaused`` synthetic
# event — keeper-py reads neither the new table nor the event (the
# reader is the thin ``keeper autopilot`` viewer, fed via the UDS
# subscribe wire), so the bump is whitelist-only with no reader logic
# change.
# Bump this set when a keeper schema change alters those tables.
#
# ``get_epic`` / ``get_job`` (fn-627) consume columns that pre-date the
# supported range: ``jobs.transcript_path`` / ``jobs.cwd`` / ``jobs.state``
# are first-class columns in ``CREATE_JOBS`` (no version gate), ``jobs.plan_verb``
# landed in v10 (well below v31), and ``epics.tasks`` / ``epics.jobs`` are
# JSON-TEXT cells whose embedded shapes (``EmbeddedJob.created_at`` etc.)
# are stable across the whole v31-v49 window — so the new readers add no
# tighter version dependency than the existing scaffold.
#
# v49 (fn-670 T2) is a whitelist-only bump: the new
# ``last_commit_for_task_at`` field rides FREE inside the opaque
# ``epics.tasks[].jobs[]`` JSON-TEXT cell, so keeper-py reads the field
# pass-through without a SQL change. The bump is still listed here
# because keeper-py is a hard whitelist (not a floor/ceiling), and a
# v49 daemon would fail every ``commit-work`` on the host until this
# set was updated. ``test/schema-version.test.ts`` enforces.
#
# v50 (fn-678 epic, T1) is a whitelist-only bump: adds the new
# ``pending_dispatches`` reducer projection table (the durable substrate
# that replaces fn-674's live zellij tab-name probe for launch-window
# double-dispatch suppression). keeper-py reads neither this table nor
# the new ``Dispatched`` / ``DispatchExpired`` synthetic events
# (autopilot surface, not the attribution surface keeper-py serves), so
# the bump is whitelist-only with no reader logic change.
#
# v51 (fn-682 epic, T1) is a whitelist-only bump: adds the new
# ``jobs.monitors`` JSON-array projection column (live per-session
# background-shell snapshot with three-way provenance —
# ``monitor`` / ``bash-bg`` / ``ambient``) plus the sparse
# ``events.background_task_id`` deriver column + its partial index that
# feeds the reducer's in-fold provenance scan. keeper-py reads neither
# ``jobs.monitors`` nor ``events.background_task_id`` (attribution
# surface only — the monitors projection serves the ``keeper jobs``
# viewer), so the bump is whitelist-only with no reader logic change.
#
# v52 (fn-686 epic, T1) is a whitelist-only bump: adds the paired
# ``jobs.last_permission_prompt_at`` / ``jobs.last_permission_prompt_kind``
# projection columns that surface "session blocked on a Claude Code
# permission dialog or MCP elicitation prompt" via the board
# ``[awaiting:permission]`` / ``[awaiting:elicitation]`` pill. keeper-py
# reads neither column (attribution surface only — the pill renders out
# of the ``keeper board`` viewer's projection read), so the bump is
# whitelist-only with no reader logic change.
#
# v53 (fn-688 epic, T1) is a whitelist-only bump: adds the new
# ``epic_tombstones`` projection table that guards every epic-shell-
# INSERT site against the deleted-epic resurrection bug (a later
# job-side fold whose ``plan_ref`` still points at the now-gone epic
# re-shells the row with NULL scalars, rendering as a headerless
# "ghost" block at the top of ``keeper board``). keeper-py reads
# neither ``epic_tombstones`` nor any of the guarded shell-INSERT
# code paths (attribution surface only — the board renderer is the
# only consumer affected by the ghost-row fix), so the bump is
# whitelist-only with no reader logic change.
SUPPORTED_SCHEMA_VERSIONS = frozenset(
    {
        31,
        32,
        33,
        34,
        35,
        36,
        37,
        38,
        39,
        40,
        41,
        42,
        43,
        44,
        45,
        46,
        47,
        48,
        49,
        50,
        51,
        52,
        53,
    }
)


class KeeperError(Exception):
    """Base class for keeper-py failures."""


class KeeperDBMissing(KeeperError):
    """``keeper.db`` does not exist — the daemon never ran on this host."""


class KeeperSchemaError(KeeperError):
    """``keeper.db`` schema version is outside the supported set.

    Raised loud rather than returning wrong data: a schema the reader does
    not understand may have moved columns the attribution query depends on.
    """


def _resolve_db_path() -> Path:
    """Resolve ``keeper.db`` the same way keeper's ``resolveDbPath`` does.

    ``KEEPER_DB`` env var wins (tests, inspect tooling); otherwise the
    ``~/.local/state/keeper/keeper.db`` default.  Kept byte-identical to
    ``src/db.ts`` so the reader and the daemon never disagree on which file
    is canonical.
    """
    override = os.environ.get("KEEPER_DB")
    if override:
        return Path(override)
    return Path.home() / ".local" / "state" / "keeper" / "keeper.db"


def _open_readonly(path: Path) -> sqlite3.Connection:
    """Open *path* read-only with the consumer pragmas keeper sanctions.

    ``mode=ro`` fails fast if the file is absent and forbids writes;
    ``query_only`` is engine-level defense-in-depth; ``busy_timeout`` lets a
    reader wait out a WAL checkpoint instead of erroring with SQLITE_BUSY.
    We never touch ``journal_mode`` (the producer owns it) and never use
    ``immutable=1`` / ``nolock=1`` (keeper writes WAL frames live).
    """
    if not path.exists():
        raise KeeperDBMissing(f"keeper DB not found at {path}")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.execute("PRAGMA query_only = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def _check_schema(conn: sqlite3.Connection) -> None:
    """Raise ``KeeperSchemaError`` unless the keeper schema is supported.

    keeper stores its version as a ``meta`` key/value row (``value`` is TEXT),
    read the same way ``src/db.ts`` reads it.
    """
    try:
        row = conn.execute(
            "SELECT value FROM meta WHERE key = 'schema_version'"
        ).fetchone()
    except sqlite3.Error as exc:
        raise KeeperSchemaError(f"keeper DB has no readable meta row: {exc}") from exc
    if row is None:
        raise KeeperSchemaError("keeper DB has no meta schema_version row")
    try:
        version = int(row[0])
    except (TypeError, ValueError) as exc:
        raise KeeperSchemaError(
            f"keeper schema_version is not an integer: {row[0]!r}"
        ) from exc
    if version not in SUPPORTED_SCHEMA_VERSIONS:
        raise KeeperSchemaError(
            f"keeper DB schema v{version} is not supported by this keeper-py "
            f"(supports {sorted(SUPPORTED_SCHEMA_VERSIONS)}); upgrade keeper-py"
        )


def _git_root(cwd: str | None) -> str | None:
    """Return the git toplevel owning *cwd* via a live ``git rev-parse``, or None.

    Resolved live (not from any cached projection) so a freshly-checked-out or
    never-snapshotted repo still resolves correctly.  ``git`` already returns
    the innermost worktree's toplevel, so nested checkouts resolve to the inner
    repo without manual longest-prefix logic.  Returns ``None`` when *cwd* is
    falsy, not inside a git repo, or ``git`` can't be run.
    """
    if not cwd:
        return None
    try:
        result = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None
    if result.returncode != 0:
        return None
    root = result.stdout.strip()
    return root or None


def _live_dirty_paths(project_dir: str) -> set[str] | None:
    """Return the set of dirty repo-relative paths in *project_dir*, live.

    Runs ``git status --porcelain -z --untracked-files=all`` at call time —
    the ground-truth dirty set, never a cached snapshot that can lag behind a
    just-landed edit.  Returns ``None`` when the dirty set can't be determined
    (not a repo, ``git`` missing, non-zero exit, timeout) so the caller can
    FAIL OPEN — keeping every on-hook file rather than silently dropping one.

    Porcelain-v1 ``-z`` parse: each record is ``XY <path>\\0``; rename/copy
    records carry the original path as the following NUL-separated field, so
    both the new and original paths join the dirty set.
    """
    try:
        result = subprocess.run(
            [
                "git",
                "-C",
                project_dir,
                "status",
                "--porcelain",
                "-z",
                "--untracked-files=all",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None
    if result.returncode != 0:
        return None
    dirty: set[str] = set()
    entries = result.stdout.split("\0")
    i = 0
    while i < len(entries):
        entry = entries[i]
        if len(entry) < 4:
            i += 1
            continue
        status = entry[0]
        dirty.add(entry[3:])
        # Rename/copy records carry the original path in the next field.
        if status in ("R", "C"):
            i += 1
            if i < len(entries) and entries[i]:
                dirty.add(entries[i])
        i += 1
    return dirty


def get_session_dirty_files(session_id: str, cwd: str) -> dict:
    """Return the files *session_id* is on the hook for, grouped by repo.

    Shape::

        {
          "files_by_repo": {"<repo abs path>": ["<repo-relative path>", ...]},
          "cwd_repo": "<repo abs path>" | None,
        }

    A file qualifies when the session has an undischarged mutation row for it
    (``last_commit_at IS NULL OR last_commit_at < last_mutation_at``) AND the
    file is currently dirty per a LIVE ``git status`` in its repo.  Dirtiness
    is verified live — never from a cached projection that can lag behind a
    just-landed edit — and FAILS OPEN: a repo whose ``git status`` can't be
    read keeps all its on-hook files rather than silently dropping them.
    ``.planctl/`` exclusion is NOT done here — that is the caller's partition
    (jobctl routes ``.planctl`` through the planctl-commit hook).

    Raises ``KeeperDBMissing`` if ``keeper.db`` is absent and
    ``KeeperSchemaError`` if its schema is unsupported — callers should treat
    both as hard failures (build-forward: no silent fallback).
    """
    path = _resolve_db_path()
    conn = _open_readonly(path)
    try:
        _check_schema(conn)
        on_hook: list[tuple[str, str]] = list(
            conn.execute(
                "SELECT project_dir, file_path FROM file_attributions "
                "WHERE session_id = ? "
                "AND (last_commit_at IS NULL OR last_commit_at < last_mutation_at)",
                (session_id,),
            )
        )
    finally:
        # Release the read-only handle before shelling out to git so the
        # connection window stays narrow (git probes run lock-free).
        conn.close()

    on_hook_by_repo: dict[str, list[str]] = {}
    for project_dir, file_path in on_hook:
        on_hook_by_repo.setdefault(project_dir, []).append(file_path)

    files_by_repo: dict[str, list[str]] = {}
    for project_dir, candidates in on_hook_by_repo.items():
        dirty = _live_dirty_paths(project_dir)
        # dirty is None → git status unreadable → fail open (keep all).
        kept = candidates if dirty is None else [p for p in candidates if p in dirty]
        if kept:
            # Stable order for deterministic output (callers may diff the list).
            files_by_repo[project_dir] = sorted(kept)

    # cwd_repo is resolved live so it is correct even when the cwd's repo has
    # nothing on the hook and was never snapshotted by keeper's git-worker.
    cwd_repo = _git_root(cwd)

    return {"files_by_repo": files_by_repo, "cwd_repo": cwd_repo}


def get_session_titles() -> dict[str, str]:
    """Return ``{session_id: title}`` for every job that has a title.

    Reads keeper's ``jobs`` projection (``job_id`` is the session id in v1;
    ``title`` is the human-readable session name, seeded at SessionStart and
    refined by prompt/transcript per the reducer's ``title_source``
    precedence).  Jobs with a NULL ``title`` are omitted, mirroring the old
    hooks-tracker ``WHERE name IS NOT NULL`` filter.

    Raises ``KeeperDBMissing`` / ``KeeperSchemaError`` like the other readers
    here — no silent fallback.
    """
    path = _resolve_db_path()
    conn = _open_readonly(path)
    try:
        _check_schema(conn)
        return {
            job_id: title
            for job_id, title in conn.execute(
                "SELECT job_id, title FROM jobs WHERE title IS NOT NULL"
            )
        }
    finally:
        conn.close()


def get_session_name_history() -> dict[str, list[str]]:
    """Return ``{session_id: [title, ...]}`` for every job's name history.

    Reads keeper's ``jobs.name_history`` column (schema v40, fn-652): a JSON
    array of the distinct titles a session has carried, oldest→newest, capped
    at the most-recent 20.  Used by claudectl to resolve a session by any name
    it ever had (retiring the old hooks-tracker ``load_all_session_names``).

    A malformed or empty ``name_history`` cell folds to ``[]`` for that job
    (defensive — never raise on a single bad row, mirroring
    ``_dirty_paths_by_repo``).  Every job row is included, even ones whose
    history is empty, so callers can distinguish "no history" from "no such
    session".

    Raises ``KeeperDBMissing`` / ``KeeperSchemaError`` like the other readers
    here — no silent fallback.
    """
    path = _resolve_db_path()
    conn = _open_readonly(path)
    try:
        _check_schema(conn)
        out: dict[str, list[str]] = {}
        for job_id, name_history in conn.execute(
            "SELECT job_id, name_history FROM jobs"
        ):
            history: list[str] = []
            try:
                parsed = json.loads(name_history)
                if isinstance(parsed, list):
                    history = [n for n in parsed if isinstance(n, str)]
            except (ValueError, TypeError):
                history = []
            out[job_id] = history
        return out
    finally:
        conn.close()


def get_session_for_pid(pid: int) -> str | None:
    """Return the latest session id whose ``jobs.pid`` equals *pid*, or ``None``.

    Reads keeper's ``jobs`` projection.  ``ORDER BY updated_at DESC LIMIT 1``
    picks the freshest row for *pid* — pid reuse is real (the OS recycles
    pids), so a long-running consumer can match a recycled pid's newer
    unrelated job.  Callers that need authoritative identity should prefer the
    ``CLAUDE_CODE_SESSION_ID`` env var and treat this lookup as best-effort
    (the documented contract in ``cli_common.session_context``).

    The ``idx_jobs_pid`` covering index added in fn-615.1 keeps the lookup
    O(log n) even as ``jobs`` grows.

    Raises ``KeeperDBMissing`` / ``KeeperSchemaError`` like the other readers
    here — no silent fallback.
    """
    path = _resolve_db_path()
    conn = _open_readonly(path)
    try:
        _check_schema(conn)
        row = conn.execute(
            "SELECT job_id FROM jobs WHERE pid = ? ORDER BY updated_at DESC LIMIT 1",
            (pid,),
        ).fetchone()
        return row[0] if row is not None else None
    finally:
        conn.close()


def get_session_identity_for_pid(pid: int) -> dict | None:
    """Return the live identity of the session owning *pid*, or ``None``.

    Shape::

        {"session_id": "<job_id>",
         "title": "<current name>" | None,    # NULL title -> None
         "name_history": ["<oldest>", ..., "<newest>"]}

    Purpose-built single-read seam for chatctl, which keys its channels by the
    Claude harness pid and needs the *live* (post-rename) session title plus
    the full name history together — replacing the frozen launch-argv name
    that went stale on every rename.  Composes what ``get_session_for_pid`` /
    ``get_session_titles`` / ``get_session_name_history`` each expose, but in
    one ``jobs`` read keyed by pid so callers don't open the db three times.

    ``ORDER BY updated_at DESC LIMIT 1`` mirrors ``get_session_for_pid`` — pid
    reuse is real (the OS recycles pids), so the freshest row for *pid* wins
    and callers treat this as best-effort correlation, not authoritative
    identity.  ``name_history`` decodes DEFENSIVELY (malformed / non-list cell
    folds to ``[]``), mirroring ``get_session_name_history``.

    Raises ``KeeperDBMissing`` / ``KeeperSchemaError`` like the other readers
    here — no silent fallback.
    """
    path = _resolve_db_path()
    conn = _open_readonly(path)
    try:
        _check_schema(conn)
        row = conn.execute(
            "SELECT job_id, title, name_history FROM jobs "
            "WHERE pid = ? ORDER BY updated_at DESC LIMIT 1",
            (pid,),
        ).fetchone()
        if row is None:
            return None
        job_id, title, name_history = row
        return {
            "session_id": job_id,
            "title": title if title else None,
            "name_history": [
                n for n in _decode_json_list(name_history) if isinstance(n, str)
            ],
        }
    finally:
        conn.close()


def _decode_json_list(cell: object) -> list:
    """Decode a JSON-TEXT cell defensively to a ``list``.

    Mirrors the ``Array.isArray(x) ? x : []`` defense the TS renderer relies
    on and the ``_dirty_paths_by_repo`` malformed-cell handler: a parse error,
    a non-string cell, or a non-list payload all fold to ``[]`` rather than
    raising — so a single bad row never breaks the reader.
    """
    if not isinstance(cell, (str, bytes, bytearray)):
        return []
    try:
        parsed = json.loads(cell)
    except (ValueError, TypeError):
        return []
    return parsed if isinstance(parsed, list) else []


def get_epic(epic_id: str) -> dict | None:
    """Return one epic row as a ``dict``, or ``None`` when no row matches.

    Shape::

        {
          "epic_id": "<id>",
          "project_dir": "<abs path>" | None,
          "tasks": [<embedded task dict>, ...],   # decoded from JSON-TEXT
          "jobs":  [<embedded job dict>, ...],    # decoded from JSON-TEXT
        }

    Reads keeper's ``epics`` projection.  The ``tasks`` / ``jobs`` columns
    are JSON-TEXT (``NOT NULL DEFAULT '[]'``) and are decoded DEFENSIVELY
    via :func:`_decode_json_list` — a malformed cell folds to ``[]``,
    mirroring the TS renderer's ``Array.isArray(x) ? x : []`` defense.
    Embedded items inside the arrays (e.g. ``EmbeddedJob`` fields like
    ``created_at`` the downstream freshest-pick relies on) ride opaque —
    the reader does not validate their inner shape.

    Consumed by ``planctl render-approve-context`` to walk an epic's
    embedded ``jobs`` / ``tasks[].jobs`` arrays when picking a target job
    for the ``/plan:approve`` evidence read.

    Raises ``KeeperDBMissing`` / ``KeeperSchemaError`` like the other
    readers here — no silent fallback.
    """
    path = _resolve_db_path()
    conn = _open_readonly(path)
    try:
        _check_schema(conn)
        row = conn.execute(
            "SELECT epic_id, project_dir, tasks, jobs FROM epics WHERE epic_id = ?",
            (epic_id,),
        ).fetchone()
        if row is None:
            return None
        epic_id_, project_dir, tasks_cell, jobs_cell = row
        return {
            "epic_id": epic_id_,
            "project_dir": project_dir,
            "tasks": _decode_json_list(tasks_cell),
            "jobs": _decode_json_list(jobs_cell),
        }
    finally:
        conn.close()


def get_job(job_id: str) -> dict | None:
    """Return one job row as a ``dict``, or ``None`` when no row matches.

    Shape::

        {
          "job_id": "<id>",
          "transcript_path": "<abs path>" | None,
          "cwd": "<abs path>" | None,
          "state": "<lifecycle state>",
        }

    Reads keeper's ``jobs`` projection.  All four columns are real columns
    on ``CREATE_JOBS`` (no JSON decode); ``transcript_path`` / ``cwd`` are
    nullable, ``state`` is ``NOT NULL DEFAULT 'stopped'``.

    Consumed by ``planctl render-approve-context`` to resolve the target
    session's transcript file (read live, fresh) and project working dir
    for the ``/plan:approve`` final-message extract.

    Raises ``KeeperDBMissing`` / ``KeeperSchemaError`` like the other
    readers here — no silent fallback.
    """
    path = _resolve_db_path()
    conn = _open_readonly(path)
    try:
        _check_schema(conn)
        row = conn.execute(
            "SELECT job_id, transcript_path, cwd, state FROM jobs WHERE job_id = ?",
            (job_id,),
        ).fetchone()
        if row is None:
            return None
        job_id_, transcript_path, cwd, state = row
        return {
            "job_id": job_id_,
            "transcript_path": transcript_path,
            "cwd": cwd,
            "state": state,
        }
    finally:
        conn.close()


def get_latest_session() -> dict | None:
    """Return the most-recently-updated job, or ``None`` when no jobs exist.

    Shape (matches the ``cli_common.session_context.show_context`` schema)::

        {"session-id": "<job_id>", "cwd": "<cwd or None>",
         "session-name": "<title>"}  # session-name omitted when title is NULL

    Reads keeper's ``jobs`` projection.  ``ORDER BY updated_at DESC LIMIT 1``
    selects the freshest job — the reducer stamps ``updated_at`` on
    SessionStart / resume / UserPromptSubmit and every projection-touching
    fold, so "latest by updated_at" tracks the currently-active session.

    Raises ``KeeperDBMissing`` / ``KeeperSchemaError`` like the other readers
    here — no silent fallback.
    """
    path = _resolve_db_path()
    conn = _open_readonly(path)
    try:
        _check_schema(conn)
        row = conn.execute(
            "SELECT job_id, cwd, title FROM jobs ORDER BY updated_at DESC LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        job_id, cwd, title = row
        out: dict = {"session-id": job_id, "cwd": cwd}
        if title is not None:
            out["session-name"] = title
        return out
    finally:
        conn.close()
