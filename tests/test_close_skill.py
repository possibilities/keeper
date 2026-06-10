"""Tests for the /plan:close skill orchestration logic.

The close skill is a Markdown + agent-prose coordinator. The Python-level
contracts it delegates to — the verdict schema and the close-phase submit verbs
(`audit submit` / `verdict submit` / `followup submit`) — are exercised by their
own dedicated test modules. This module's remaining coverage is the auditor
fixture sanity check the close pipeline relies on.
"""

from __future__ import annotations

from pathlib import Path

_AUDITOR_FIXTURES_DIR = Path(__file__).parent / "fixtures" / "auditor"


def _load_auditor_fixture(name: str) -> str:
    return (_AUDITOR_FIXTURES_DIR / name).read_text()


class TestAuditorFixtures:
    def test_clean_fixture_exists_and_is_nonempty(self):
        content = _load_auditor_fixture("clean.md")
        assert "Quality Audit Report" in content
        assert len(content) > 50

    def test_with_findings_fixture_exists_and_mentions_findings(self):
        content = _load_auditor_fixture("with_findings.md")
        assert "Should Fix" in content or "Consider" in content
