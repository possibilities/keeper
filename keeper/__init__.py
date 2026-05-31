"""keeper-py — read-only Python reader for keeper's projections.

The keeper daemon (Bun + bun:sqlite) owns the event log and writes the
``file_attributions`` / ``git_status`` projections into ``keeper.db``.  This
package is a consumer: it opens that DB read-only and answers "which dirty
files is a session on the hook for?" — nothing more.  Keeping the surface
tiny lets keeper absorb schema churn behind one stable function.
"""

from keeper.api import (
    KeeperDBMissing,
    KeeperError,
    KeeperSchemaError,
    get_latest_session,
    get_session_dirty_files,
    get_session_for_pid,
    get_session_titles,
)

__all__ = [
    "get_latest_session",
    "get_session_dirty_files",
    "get_session_for_pid",
    "get_session_titles",
    "KeeperError",
    "KeeperDBMissing",
    "KeeperSchemaError",
]
