#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
# one-shot for fn-488-explicit-plan-state-commit-seams.3
#
# Move every ``worker_acked_at`` / ``closer_acked_at`` stamp out of the
# tracked task / epic JSON and into the gitignored SQLite at
# ``<repo>/.planctl/state/acks.db``.  After this script runs the
# tracked JSON carries no ack fields and the bundle builder is the
# sole reader / writer of ack state (via the new ``planctl.acks``
# module).
#
# Behavior:
#   - Calls ``devctl list-roots`` to enumerate parent roots; falls back to
#     ``[/Users/mike/code]`` with a loud WARN when devctl fails.
#   - For each root, globs ``<root>/*/.planctl/`` projects.
#   - For each project:
#       * Open (or create) ``<project>/.planctl/state/acks.db``.
#       * Walk ``epics/*.json``; for each epic with a non-null
#         ``closer_acked_at``: UPSERT into ``epic_acks``, pop the
#         field, atomic-rewrite the JSON.
#       * Walk ``tasks/*.json``; for each task with a non-null
#         ``worker_acked_at``: UPSERT into ``task_acks``, pop the
#         field, atomic-rewrite the JSON.
#   - Idempotent on re-run (UPSERT semantics + pop-only-on-present).
#   - Defensive: a present-but-null value (which is what the pre-fn-488
#     normalizers wrote for legacy records without an ack) is also
#     popped so the JSON stays clean even when there's nothing to
#     copy.
#   - Prints one summary line:
#     ``migrated T/E acks, scrubbed T'/E' JSONs across K projects``.
#
# Does NOT commit.  Single-threaded — the total file count is well
# under a second's worth of work and parallelism would only add bug
# surface (sqlite is per-project so they couldn't share connections
# anyway).

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path


def _atomic_write_json(path: Path, data: dict) -> None:
    """Inline mirror of ``planctl.store.atomic_write_json``.

    The PEP 723 script env is isolated from the workspace, so we cannot
    import ``planctl.store`` directly.  Format matches byte-for-byte:
    ``json.dumps(data, indent=2, sort_keys=True) + "\\n"``, temp-file
    written next to ``path`` then ``os.replace``'d for atomicity.  No
    touched-paths logging — this is a one-shot migration, not a planctl
    verb.
    """
    content = json.dumps(data, indent=2, sort_keys=True) + "\n"
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        tmp.write(content)
        tmp_path = tmp.name
    os.replace(tmp_path, path)


def _list_roots() -> list[Path]:
    """Enumerate parent roots via ``devctl list-roots``; fall back loudly."""
    try:
        result = subprocess.run(
            ["devctl", "list-roots"],
            check=True,
            capture_output=True,
            text=True,
        )
        roots = [
            Path(line.strip()) for line in result.stdout.splitlines() if line.strip()
        ]
        if not roots:
            raise RuntimeError("devctl list-roots returned no roots")
        return roots
    except (subprocess.CalledProcessError, FileNotFoundError, RuntimeError) as e:
        print(
            f"WARN: devctl list-roots failed ({e}); falling back to [/Users/mike/code]",
            file=sys.stderr,
        )
        return [Path("/Users/mike/code")]


def _open_db(project_planctl_dir: Path) -> sqlite3.Connection:
    """Mirror of ``planctl.acks._open_for_write`` — write-side semantics."""
    state_dir = project_planctl_dir / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    db_path = state_dir / "acks.db"
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS task_acks ("
        "  task_id TEXT PRIMARY KEY,"
        "  acked_at TEXT NOT NULL"
        ")"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS epic_acks ("
        "  epic_id TEXT PRIMARY KEY,"
        "  acked_at TEXT NOT NULL"
        ")"
    )
    return conn


def _migrate_one_project(planctl_dir: Path) -> tuple[int, int, int, int]:
    """Migrate one project's tracked acks into acks.db.

    Returns ``(task_acks_copied, epic_acks_copied, task_files_scrubbed, epic_files_scrubbed)``.
    """
    tasks_dir = planctl_dir / "tasks"
    epics_dir = planctl_dir / "epics"
    if not tasks_dir.exists() and not epics_dir.exists():
        return (0, 0, 0, 0)

    conn = _open_db(planctl_dir)
    task_copied = 0
    epic_copied = 0
    task_scrubbed = 0
    epic_scrubbed = 0
    try:
        if epics_dir.exists():
            for path in epics_dir.glob("*.json"):
                with path.open(encoding="utf-8") as f:
                    obj = json.load(f)
                if "closer_acked_at" not in obj:
                    continue
                value = obj.get("closer_acked_at")
                epic_id = obj.get("id") or path.stem
                if value is not None:
                    conn.execute(
                        "INSERT INTO epic_acks(epic_id, acked_at) VALUES (?, ?) "
                        "ON CONFLICT(epic_id) DO UPDATE SET acked_at=excluded.acked_at",
                        (epic_id, value),
                    )
                    epic_copied += 1
                obj.pop("closer_acked_at")
                _atomic_write_json(path, obj)
                epic_scrubbed += 1

        if tasks_dir.exists():
            for path in tasks_dir.glob("*.json"):
                with path.open(encoding="utf-8") as f:
                    obj = json.load(f)
                if "worker_acked_at" not in obj:
                    continue
                value = obj.get("worker_acked_at")
                task_id = obj.get("id") or path.stem
                if value is not None:
                    conn.execute(
                        "INSERT INTO task_acks(task_id, acked_at) VALUES (?, ?) "
                        "ON CONFLICT(task_id) DO UPDATE SET acked_at=excluded.acked_at",
                        (task_id, value),
                    )
                    task_copied += 1
                obj.pop("worker_acked_at")
                _atomic_write_json(path, obj)
                task_scrubbed += 1

        conn.commit()
    finally:
        conn.close()
    return (task_copied, epic_copied, task_scrubbed, epic_scrubbed)


def main() -> int:
    roots = _list_roots()
    total_t = 0
    total_e = 0
    total_ts = 0
    total_es = 0
    project_count = 0
    for root in roots:
        for planctl_dir in root.glob("*/.planctl"):
            if not planctl_dir.is_dir():
                continue
            t, e, ts, es = _migrate_one_project(planctl_dir)
            total_t += t
            total_e += e
            total_ts += ts
            total_es += es
            project_count += 1
    print(
        f"migrated {total_t}/{total_e} task/epic acks, "
        f"scrubbed {total_ts}/{total_es} task/epic JSONs across {project_count} projects"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
