"""Consistency checks for the hand-written `next` source skill.

`skills/next/SKILL.md` is tracked source — the board-priority sibling of
`defer`. It does NOT scaffold; it flips `queue_jump` on an *existing* epic
via `planctl epic queue-jump`. This module pins the invariants that keep it
healthy:

1. **The skill file exists** at the documented path.
2. **`name: next`** (the bare verb name, no `plan:` prefix).
3. **References `planctl epic queue-jump`** in a fenced bash block — the only
   mutating verb the skill invokes.
4. **Every `planctl <verb>` in a fenced bash block resolves via `CliRunner`** —
   the verb-existence guard (notably `epic queue-jump`).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from click.testing import CliRunner
from planctl.cli import cli

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_REPO_PLANCTL: Path = Path(__file__).resolve().parents[1]
_NEXT_SKILL: Path = _REPO_PLANCTL / "skills" / "next" / "SKILL.md"

# Multi-word verb prefixes — sourced from work_skill_consistency for symmetry.
_MULTIWORD_PREFIXES: frozenset[str] = frozenset(
    {"epic", "task", "worker", "dep", "config"}
)


# ---------------------------------------------------------------------------
# Existence + frontmatter
# ---------------------------------------------------------------------------


def test_next_skill_exists():
    """The next skill must exist as tracked source at the documented path."""
    assert _NEXT_SKILL.is_file(), (
        f"{_NEXT_SKILL} missing — next is hand-written tracked source, not a "
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


def test_next_skill_name_is_bare_next():
    """`name:` must be the bare verb `next` — no `plan:` prefix on the
    hand-written source skill.
    """
    fm = _parse_frontmatter_keys(_read_frontmatter_block(_NEXT_SKILL))
    assert fm.get("name") == "next", fm


def test_next_skill_references_epic_queue_jump():
    """The next skill must reference `planctl epic queue-jump` — its only
    mutating verb.
    """
    assert "planctl epic queue-jump" in _NEXT_SKILL.read_text(), (
        f"{_NEXT_SKILL} does not reference `planctl epic queue-jump` — the "
        "mutation seam regressed."
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
    """Verbs extracted from the next skill."""
    if _NEXT_SKILL.is_file():
        return _extract_planctl_verbs(_NEXT_SKILL.read_text())
    return []


_VERBS: list[tuple[str, ...]] = _all_verbs()


def test_extracted_verbs_nonempty():
    """Sanity: at least one verb must surface — the skill embeds
    `planctl epic queue-jump` in a fenced bash block.
    """
    assert len(_VERBS) > 0, (
        "no planctl verbs extracted from next/SKILL.md — either the file is "
        "missing or the fenced-bash extractor regressed."
    )


def test_next_skill_extracts_epic_queue_jump_verb():
    """The `epic queue-jump` verb path must surface from the fenced-bash
    extraction — pins the exact invocation the verb-existence guard checks.
    """
    assert ("epic", "queue-jump") in _VERBS, (
        "next/SKILL.md does not embed `planctl epic queue-jump` in a fenced "
        f"bash block — extracted verbs: {_VERBS}"
    )


@pytest.mark.parametrize(
    "verb_parts",
    _VERBS,
    ids=lambda parts: "planctl-" + "-".join(parts),
)
def test_next_planctl_verbs_have_help(verb_parts: tuple[str, ...]):
    """Every `planctl <verb>` referenced in a fenced bash block of the next
    skill must respond to `--help` with exit code 0.

    Mirrors the verb-existence guard from `test_work_skill_consistency`.
    """
    result = CliRunner().invoke(cli, [*verb_parts, "--help"])
    assert result.exit_code == 0, (
        f"planctl {' '.join(verb_parts)} --help failed:\n{result.output}"
    )
