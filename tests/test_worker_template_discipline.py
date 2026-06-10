"""Prose-consistency checks for the worker agent template's comment discipline.

The `## Doc & comment discipline` block in `template/agents/worker.md.tmpl` is
the single source of the canonical comment + doc rules every prompt surface
echoes. These tests scan the TEMPLATE source (never a rendered
`agents/worker-*.md`, which is gitignored and guard-protected) so the block and
its protected-comments allowlist can't silently drift out of the template.

Mirrors the template-scanning pattern in `test_work_skill_consistency.py`.
"""

from __future__ import annotations

import re
from pathlib import Path

_TMPL_PATH: Path = (
    Path(__file__).resolve().parents[1] / "template" / "agents" / "worker.md.tmpl"
)


def _discipline_section(tmpl_text: str) -> str:
    """Return the body of the `## Doc & comment discipline` section.

    Captures everything from the heading up to the next `## ` heading, so a
    test can assert on the block's bullets in isolation.
    """
    m = re.search(
        r"^## Doc & comment discipline\s*\n(.*?)(?=^## )",
        tmpl_text,
        re.DOTALL | re.MULTILINE,
    )
    assert m is not None, (
        "`## Doc & comment discipline` section not found in worker.md.tmpl"
    )
    return m.group(1)


def test_template_has_discipline_heading_before_rules():
    """The discipline section must exist and sit immediately before `## Rules`."""
    tmpl = _TMPL_PATH.read_text()
    assert "## Doc & comment discipline" in tmpl, (
        "worker.md.tmpl is missing the `## Doc & comment discipline` heading"
    )
    discipline_idx = tmpl.index("## Doc & comment discipline")
    rules_idx = tmpl.index("## Rules", discipline_idx)
    # No other `## ` heading may appear between the two — discipline is the
    # section directly preceding `## Rules`.
    between = tmpl[discipline_idx + len("## Doc & comment discipline") : rules_idx]
    assert "\n## " not in between, (
        "`## Doc & comment discipline` must be placed immediately before "
        f"`## Rules`; found an intervening section:\n{between}"
    )


def test_template_discipline_has_protected_comments_line():
    """The block must carry the protected-comments allowlist bullet."""
    section = _discipline_section(_TMPL_PATH.read_text())
    assert "Protected comments" in section, (
        "the discipline block must include the protected-comments allowlist "
        "bullet — without it a worker may strip functional suppressions"
    )
    # Spot-check the allowlist names the functional suppressions it protects.
    for needle in ("noqa", "type: ignore", "SPDX"):
        assert needle in section, f"protected-comments bullet does not name {needle!r}"


def test_template_discipline_at_most_five_bullets():
    """The block stays at or under the 5-bullet ceiling the epic sets."""
    section = _discipline_section(_TMPL_PATH.read_text())
    bullets = [ln for ln in section.splitlines() if ln.startswith("- ")]
    assert 1 <= len(bullets) <= 5, (
        f"discipline block has {len(bullets)} top-level bullets; the ceiling "
        f"is 5. Bullets:\n" + "\n".join(bullets)
    )


def test_template_discipline_carries_no_ticket_ids():
    """No bullet may carry a ticket/epic id or backward-facing tombstone."""
    section = _discipline_section(_TMPL_PATH.read_text())
    # `fn-N` provenance ids and the literal scaffold-phrasing tombstones the
    # canon forbids in code comments must not appear in the block prose itself.
    assert not re.search(r"\bfn-\d+\b", section), (
        "discipline block prose contains an `fn-N` ticket id — the canon "
        "forbids provenance ids; the block must state the rule, not cite one"
    )
