#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
# one-shot for fn-18-investigate-worker-dropoffs.2
#
# Emit a deterministic *probe epic* spec whose worker spawn is tuned to
# approach the 17-35 tool-use drop band observed in the task-1 corpus
# classification (.planctl/scouts/fn-18-investigate-worker-dropoffs/
# findings/01-corpus-classification.md).
#
# The probe epic is a read-only investigation target: each of its three
# tasks asks the worker to re-anchor, read several files, grep the repo,
# and produce a short memo. No git mutations, no planctl state edits.
# This keeps the probe cheap and reversible while still burning the
# Phase-1 + Phase-1.5 tool budget the real worker drops cluster around.
#
# Why this shape: drop-row tool_uses median is 29 (range 17-35 over
# 7/8 canonical drops). A worker that reads the 5 required files listed
# below, greps for 2-3 patterns, and writes one memo file will land in
# that band almost exactly (5 Reads + 3 Greps + 1 Bash `git status` +
# 1 Write + ~5-10 Phase-1 re-anchor tool_uses + Phase-3 `planctl done`
# = 16-21 before commit). Force sonnet via the --model flag in the
# emitted command so we reproduce the corpus conditions.
#
# Usage:
#   uv run apps/planctl/scripts/probe_worker_durability.py \
#       --epic-id fn-probe-1 \
#       --n-tasks 3 \
#       --out-dir .planctl/state/probes
#
# Output: writes <out-dir>/<epic-id>.spec.md + per-task specs, then
# prints on stdout the exact `/plan:work` shell invocation to run
# against it. The human copies that into the parent Claude Code session
# -- this script cannot spawn subagents (it is not an agent).
#
# After the probe run completes, re-classify with:
#   uv run apps/planctl/scripts/classify_worker_dropoffs.py \
#       > /tmp/fn18-post-probe-classification.md
#
# The script is read-only-to-the-repo (writes only under --out-dir,
# which defaults to the gitignored .planctl/state/probes path). Nothing
# here hits planctl CLI or the .planctl/state dir's task database; the
# emitted spec files are inert scaffolding a follower run consumes.

from __future__ import annotations

import argparse
import sys
from pathlib import Path

PROBE_TASK_TEMPLATE = """## Description

**Size:** S
**Files:** `/tmp/fn-probe-{epic_id}-task{n}.md` (throwaway memo, gitignored by path)

### Approach

Probe task {n}/{total} for worker-durability reproduction. Deliberately tuned
to approach the 17-35 tool-use drop band. No code changes — this is a
read-only investigation that produces one memo file under /tmp.

Steps:
1. Re-anchor per worker.md Phase 1 (planctl show/cat + git status + git log).
2. Read these 5 files verbatim (burns Phase 1.5 tool budget in the drop band):
   - apps/planctl/skills/work/SKILL.md
   - apps/planctl/agents/worker.md
   - apps/planctl/CLAUDE.md
   - .planctl/scouts/fn-18-investigate-worker-dropoffs/findings/01-corpus-classification.md
   - apps/planctl/planctl/run_done.py
3. Run 3 greps (use the Grep tool, not shell grep):
   - "stop_reason" in apps/planctl/
   - "planctl done" in apps/planctl/
   - "Agent" in apps/planctl/skills/work/SKILL.md
4. Write a one-paragraph memo to /tmp/fn-probe-{epic_id}-task{n}.md
   summarising the three files that most directly gate worker durability.
5. Phase 3: call `planctl done` with a minimal summary and empty evidence.
6. Phase 5: commit nothing (no code changes; /tmp memo is deliberately
   not tracked).

### Investigation targets

**Required**:
- apps/planctl/skills/work/SKILL.md
- apps/planctl/agents/worker.md
- apps/planctl/CLAUDE.md
- .planctl/scouts/fn-18-investigate-worker-dropoffs/findings/01-corpus-classification.md
- apps/planctl/planctl/run_done.py

### Risks

- **Probe may complete healthy**, which is itself a valid observation: the
  harness cutoff is non-deterministic, and a probe that lands at 18-22
  tool_uses without being cut proves the cutoff is not a simple hard cap.
- **Probe may block on planctl done** if run_done's assignee check sees a
  stale claim from a previous aborted run; clean .planctl/state if that
  happens.

## Acceptance

- [ ] Memo file /tmp/fn-probe-{epic_id}-task{n}.md exists after run.
- [ ] Worker transcript captured for classifier (re-run classify_worker_dropoffs.py).
- [ ] Tool-use count, duration, and stop_reason recorded for the probe row.

## Done summary

## Evidence
"""


PROBE_EPIC_TEMPLATE = """## Overview

Throwaway probe epic for fn-18-investigate-worker-dropoffs.2 reproduction.
Run this under `/plan:work` in a fresh parent session to attempt a live
reproduction of the drop signature documented in 01-corpus-classification.md
(dominant: stop_reason=tool_use + planctl done == 0 + clean terminal
tool_result, at tool_uses 17-35, median 29).

All tasks are read-only and produce throwaway memos under /tmp. Delete this
epic after the probe run completes.

## Quick commands

- `/plan:work {epic_id}` — run all {n_tasks} tasks serially.
- `uv run apps/planctl/scripts/classify_worker_dropoffs.py > /tmp/fn18-post-probe.md`
  — re-classify including the fresh probe spawns.

## Acceptance

- [ ] All {n_tasks} probe tasks complete (either healthy or drop — both are data).
- [ ] Post-probe classification captures each worker row.

## References

- `.planctl/scouts/fn-18-investigate-worker-dropoffs/findings/01-corpus-classification.md`
- `apps/planctl/scripts/classify_worker_dropoffs.py`
- `apps/planctl/scripts/probe_worker_durability.py` (this script)
"""


INVOCATION_TEMPLATE = """
# Paste into a fresh parent Claude Code session:
/plan:work {epic_id}

# Then after the epic drains, regenerate the classification table:
uv run apps/planctl/scripts/classify_worker_dropoffs.py > /tmp/fn18-post-probe.md
diff .planctl/scouts/fn-18-investigate-worker-dropoffs/findings/01-corpus-classification.md /tmp/fn18-post-probe.md
"""


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--epic-id", default="fn-probe-wd", help="Probe epic id")
    p.add_argument("--n-tasks", type=int, default=3, help="Serial tasks in probe epic")
    p.add_argument(
        "--out-dir",
        default=".planctl/state/probes",
        help="Output directory (gitignored by default)",
    )
    args = p.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    epic_path = out_dir / f"{args.epic_id}.spec.md"
    epic_path.write_text(
        PROBE_EPIC_TEMPLATE.format(epic_id=args.epic_id, n_tasks=args.n_tasks)
    )

    for n in range(1, args.n_tasks + 1):
        task_path = out_dir / f"{args.epic_id}.{n}.spec.md"
        task_path.write_text(
            PROBE_TASK_TEMPLATE.format(epic_id=args.epic_id, n=n, total=args.n_tasks)
        )

    print(f"probe epic spec written to: {epic_path}")
    print(f"probe task specs: {out_dir}/{args.epic_id}.*.spec.md")
    print(INVOCATION_TEMPLATE.format(epic_id=args.epic_id))
    return 0


if __name__ == "__main__":
    sys.exit(main())
