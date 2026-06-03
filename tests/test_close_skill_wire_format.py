"""Pin the wire-format contract between the close skill and the quality-auditor agent.

The close skill (SKILL.md) is the producer: it emits a ``--- COMMIT_GROUPS ---``
fence header in the quality-auditor spawn prompt and documents that an empty array
is a legal value. The quality-auditor agent (quality-auditor.md) is the consumer:
it parses the fence and short-circuits on ``[]``.

Drift between the two files would silently break the audit path. These tests catch:

- Fence-header rename (primary drift surface): if either side changes the literal
  ``--- COMMIT_GROUPS ---`` string the delimiter stops matching.
- Empty-array short-circuit drift (secondary): if the close skill stops documenting
  the legal empty case while the auditor still expects it (or vice versa), an
  empty-commit epic is silently mis-handled.

Tests use content-grep on ``Path.read_text()`` — no subprocess render, no fixed
line numbers. Survives reorganization as long as the substrings remain present.
"""

from pathlib import Path

_REPO_ROOT = Path(__file__).parent.parent  # planctl repo root
_SKILL_MD = _REPO_ROOT / "skills/close/SKILL.md"
_AUDITOR_MD = _REPO_ROOT / "agents/quality-auditor.md"

_FENCE_HEADER = "--- COMMIT_GROUPS ---"


def test_fence_header_in_close_skill() -> None:
    """Close skill must contain the COMMIT_GROUPS fence header it emits."""
    content = _SKILL_MD.read_text()
    assert _FENCE_HEADER in content, (
        f"'--- COMMIT_GROUPS ---' not found in {_SKILL_MD}; "
        "rename would break the quality-auditor parser"
    )


def test_fence_header_in_quality_auditor() -> None:
    """Quality-auditor agent must reference the COMMIT_GROUPS fence it parses."""
    content = _AUDITOR_MD.read_text()
    assert _FENCE_HEADER in content, (
        f"'--- COMMIT_GROUPS ---' not found in {_AUDITOR_MD}; "
        "rename would break the quality-auditor parser"
    )


def test_empty_array_documented_in_close_skill() -> None:
    """Close skill must document that an empty COMMIT_GROUPS array is legal."""
    content = _SKILL_MD.read_text()
    assert "Empty array is legal" in content, (
        f"'Empty array is legal' not found in {_SKILL_MD}; "
        "close skill must document the empty-array short-circuit so the auditor "
        "contract stays in lockstep"
    )


def test_empty_array_short_circuit_in_quality_auditor() -> None:
    """Quality-auditor must document the [] short-circuit semantic."""
    content = _AUDITOR_MD.read_text()
    assert "COMMIT_GROUPS` is `[]`" in content, (
        f"'COMMIT_GROUPS` is `[]`' not found in {_AUDITOR_MD}; "
        "auditor must document the empty-array short-circuit path"
    )
