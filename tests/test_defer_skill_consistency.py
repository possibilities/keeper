"""Consistency checks for the hand-written `defer` source skill.

`skills/defer/SKILL.md` is tracked source — the sole single-task scaffolder.
This module pins the invariants that keep it healthy:

1. **The skill file exists** at the documented path.
2. **`name: defer`** (the bare verb name, no `plan:` prefix).
3. **No `queue_jump: true` literal** — defer omits the field entirely so the
   epic sorts in normal `epic_number` order. Board-priority lives in
   `/plan:next`, never here.
4. **References `planctl scaffold`** — the only mutating verb the skill invokes.
5. **Every `planctl <verb>` in a fenced bash block resolves through the CLI** —
   the verb-existence guard.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from .conftest import run_cli

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_REPO_PLANCTL: Path = Path(__file__).resolve().parents[1]
_DEFER_SKILL: Path = _REPO_PLANCTL / "skills" / "defer" / "SKILL.md"

# Multi-word verb prefixes — sourced from work_skill_consistency for symmetry.
_MULTIWORD_PREFIXES: frozenset[str] = frozenset(
    {"epic", "task", "worker", "dep", "config"}
)


# ---------------------------------------------------------------------------
# Existence + frontmatter
# ---------------------------------------------------------------------------


def test_defer_skill_exists():
    """The defer skill must exist as tracked source at the documented path."""
    assert _DEFER_SKILL.is_file(), (
        f"{_DEFER_SKILL} missing — defer is hand-written tracked source, not a "
        "generated render; restore the file."
    )


def _read_frontmatter_block(path: Path) -> str:
    """Return the raw text between the leading `---` delimiters (exclusive)."""
    text = path.read_text()
    m = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    assert m is not None, f"no frontmatter delimiter pair in {path}"
    return m.group(1)


def _parse_frontmatter_keys(block: str) -> dict[str, str]:
    """Parse top-level `key: value` lines (continuation lines folded in)."""
    fm: dict[str, str] = {}
    lines = block.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        key_match = re.match(r"^([a-zA-Z_][\w-]*):\s*(.*)$", line)
        if not key_match:
            i += 1
            continue
        key = key_match.group(1)
        value_parts = [key_match.group(2)]
        i += 1
        # Fold continuation lines (indented) into the value.
        while i < len(lines) and (
            lines[i].startswith(" ") or lines[i].startswith("\t")
        ):
            value_parts.append(lines[i].strip())
            i += 1
        fm[key] = "\n".join(value_parts).strip()
    return fm


def test_defer_skill_name_is_bare_defer():
    """`name:` must be the bare verb `defer` — no `plan:` prefix on the
    hand-written source skill.
    """
    fm = _parse_frontmatter_keys(_read_frontmatter_block(_DEFER_SKILL))
    assert fm.get("name") == "defer", fm


def test_defer_skill_omits_queue_jump_literal():
    """The defer skill must NOT carry `queue_jump: true` anywhere — defer
    omits the key entirely (defaulting to `false`). Board priority belongs to
    `/plan:next`, never here.
    """
    text = _DEFER_SKILL.read_text()
    assert "queue_jump: true" not in text, (
        "defer/SKILL.md contains `queue_jump: true` — the defer skill must omit "
        "the key entirely; board priority lives in /plan:next."
    )


def test_defer_skill_references_planctl_scaffold():
    """The defer skill must reference `planctl scaffold` — its only mutating
    verb.
    """
    assert "planctl scaffold" in _DEFER_SKILL.read_text(), (
        f"{_DEFER_SKILL} does not reference `planctl scaffold` — the mutation "
        "seam regressed."
    )


# ---------------------------------------------------------------------------
# Verb-existence guard (mirrors test_work_skill_consistency.py)
# ---------------------------------------------------------------------------


def _extract_planctl_verbs(skill_text: str) -> list[tuple[str, ...]]:
    """Extract every `planctl <verb>` invocation from fenced bash blocks."""
    verbs: set[tuple[str, ...]] = set()
    in_bash = False
    for line in skill_text.splitlines():
        stripped = line.strip()
        if stripped.startswith("```bash"):
            in_bash = True
            continue
        if stripped.startswith("```"):
            in_bash = False
            continue
        if not in_bash:
            continue
        for match in re.finditer(r"planctl\s+([\w-]+(?:\s+[\w-]+)*)", line):
            words = match.group(1).split()
            if not words:
                continue
            head = words[0]
            if head in _MULTIWORD_PREFIXES and len(words) >= 2:
                verbs.add((head, words[1]))
            else:
                verbs.add((head,))
    return sorted(verbs)


def _all_verbs() -> list[tuple[str, ...]]:
    """Verbs extracted from the defer skill."""
    if _DEFER_SKILL.is_file():
        return _extract_planctl_verbs(_DEFER_SKILL.read_text())
    return []


_VERBS: list[tuple[str, ...]] = _all_verbs()


def test_extracted_verbs_nonempty():
    """Sanity: at least one verb must surface — the skill embeds
    `planctl scaffold` in a fenced bash block.
    """
    assert len(_VERBS) > 0, (
        "no planctl verbs extracted from defer/SKILL.md — either the file is "
        "missing or the fenced-bash extractor regressed."
    )


@pytest.mark.parametrize(
    "verb_parts",
    _VERBS,
    ids=lambda parts: "planctl-" + "-".join(parts),
)
def test_defer_planctl_verbs_have_help(verb_parts: tuple[str, ...]):
    """Every `planctl <verb>` referenced in a fenced bash block of the defer
    skill must respond to `--help` with exit code 0.

    Mirrors the verb-existence guard from `test_work_skill_consistency`.
    """
    result = run_cli([*verb_parts, "--help"])
    assert result.exit_code == 0, (
        f"planctl {' '.join(verb_parts)} --help failed:\n{result.output}"
    )
