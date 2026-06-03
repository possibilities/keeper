#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
# one-shot for fn-463-scrape-epic-draft-remnants-from-planctl.1
#
# Scrub the dead ``draft`` field from every epic JSON across every parent
# root reported by ``devctl list-roots``.  The field was retired in fn-451
# (verb removal); fn-463 removes the last on-disk residue.
#
# Behavior:
#   - Calls ``devctl list-roots`` to enumerate parent roots; falls back to
#     ``[/Users/mike/code]`` with a loud WARN when devctl fails.
#   - For each root, globs ``<root>/*/.planctl/epics/*.json``.
#   - For each file: ``json.load``, ``"draft" in obj`` membership check
#     (not ``.get()`` — a present-but-None value would slip through);
#     pop and rewrite via ``planctl.store.atomic_write_json`` so the
#     on-disk format (indent=2, sort_keys=True, trailing newline) stays
#     identical except for the single-key removal.
#   - Idempotent: clean files are skipped (no rewrite, no mtime bump).
#   - Prints one summary line: ``scrubbed N/M epic JSONs across K roots``.
#
# Does NOT commit.  Single-threaded — the 68-file rewrite runs in well
# under a second and parallelism would only add bug surface.

from __future__ import annotations

import json
import os
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


def _scrub_file(path: Path) -> bool:
    """Return True if ``path`` carried the dead key and was rewritten."""
    with path.open(encoding="utf-8") as f:
        obj = json.load(f)
    if "draft" not in obj:
        return False
    obj.pop("draft")
    _atomic_write_json(path, obj)
    return True


def main() -> int:
    roots = _list_roots()
    scrubbed = 0
    total = 0
    for root in roots:
        for epics_dir in root.glob("*/.planctl/epics"):
            for path in epics_dir.glob("*.json"):
                total += 1
                if _scrub_file(path):
                    scrubbed += 1
    print(f"scrubbed {scrubbed}/{total} epic JSONs across {len(roots)} roots")
    return 0


if __name__ == "__main__":
    sys.exit(main())
