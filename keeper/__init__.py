"""keeper-py — read-only Python reader for keeper's projections.

The keeper daemon (Bun + bun:sqlite) owns the event log and writes the
``epics`` / ``jobs`` / ``file_attributions`` / ``git_status`` projections
into ``keeper.db``.  This package is a consumer: it opens that DB
read-only and exposes a small set of generic readers (see
``keeper.api`` for the full list).  Keeping the surface tight lets
keeper absorb schema churn behind a handful of stable functions.
"""

from keeper.api import (
    KeeperDBMissing,
    KeeperError,
    KeeperSchemaError,
    get_epic,
    get_job,
    get_latest_session,
    get_session_for_pid,
    get_session_name_history,
    get_session_titles,
)

__all__ = [
    "get_epic",
    "get_job",
    "get_latest_session",
    "get_session_for_pid",
    "get_session_name_history",
    "get_session_titles",
    "KeeperError",
    "KeeperDBMissing",
    "KeeperSchemaError",
]
