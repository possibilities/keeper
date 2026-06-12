"""Python race-harness peer: mint K epic ids under the SAME global epic-id lock
the bun worker uses (HOME-driven ~/.local/state path), proving cross-engine
interop. Argv: <dataDir> <count>."""

from __future__ import annotations

import sys
from pathlib import Path

from planctl.ids import scan_max_epic_id
from planctl.run_epic_create import _epic_id_lock

data_dir = Path(sys.argv[1])
count = int(sys.argv[2])

for _ in range(count):
    with _epic_id_lock():
        nxt = scan_max_epic_id(data_dir) + 1
        (data_dir / "epics" / f"fn-{nxt}-race.json").write_text("{}\n")
        (data_dir / "specs" / f"fn-{nxt}-race.md").write_text("# race\n")
