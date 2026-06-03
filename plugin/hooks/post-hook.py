#!/usr/bin/env python3
"""PostToolUse Read hook: inject a non-blocking heads-up when reading a
file that carries the ``_promptctl_path`` frontmatter marker.

Shells out to ``promptctl check-generated <file> --on read`` and, when the
envelope reports ``marked: true``, emits the softer warn-variant message
via ``additionalContext`` so the agent knows the file is generated before
trying to edit it.

planctl ships this hook standalone (no ``apps/hookctl/api`` import):
- runs under system ``python3``;
- talks to promptctl over subprocess.

Fail-open on any subprocess failure — silent pass-through is correct for
the read path (we never want to surface tool noise just because promptctl
wasn't on PATH).
"""

from __future__ import annotations

import json
import subprocess
import sys


def _call_check_generated(file_path: str) -> dict | None:
    """Run ``promptctl check-generated --on read`` and return the envelope."""
    try:
        result = subprocess.run(
            ["promptctl", "check-generated", file_path, "--on", "read"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None

    if result.returncode != 0:
        return None

    try:
        return json.loads(result.stdout.strip() or "{}")
    except json.JSONDecodeError:
        return None


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError:
        return

    if data.get("tool_name") != "Read":
        return

    file_path = data.get("tool_input", {}).get("file_path", "")
    if not file_path:
        return

    envelope = _call_check_generated(file_path)
    if not envelope or not envelope.get("marked"):
        return

    message = (envelope.get("message") or "").strip()
    if not message:
        return

    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PostToolUse",
                    "additionalContext": message,
                }
            }
        )
    )


if __name__ == "__main__":
    main()
