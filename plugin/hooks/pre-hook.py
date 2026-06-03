#!/usr/bin/env python3
"""PreToolUse Write/Edit hook: block edits to files carrying the
``_promptctl_path`` frontmatter marker.

Shells out to ``promptctl check-generated <file> --on write`` and, when the
envelope reports ``marked: true``, emits a ``permissionDecision: deny``
JSON output naming the source template + regenerate command.

planctl ships this hook standalone (no ``apps/hookctl/api`` import):
- runs under system ``python3``;
- talks to promptctl over subprocess — the sanctioned pattern (planctl
  already shells promptctl for ``render-spec`` / ``inline-sketch-refs``).

Fail-open on any subprocess failure — a hot-path hook that blocks every
Write/Edit because promptctl is broken would brick the agent surface.
"""

from __future__ import annotations

import json
import subprocess
import sys


def _call_check_generated(file_path: str) -> dict | None:
    """Run ``promptctl check-generated --on write`` and return the envelope.

    Returns ``None`` on any subprocess failure (binary missing, non-zero
    exit, malformed JSON) so the hook fails open.
    """
    try:
        result = subprocess.run(
            ["promptctl", "check-generated", file_path, "--on", "write"],
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
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": message,
                }
            }
        )
    )


if __name__ == "__main__":
    main()
