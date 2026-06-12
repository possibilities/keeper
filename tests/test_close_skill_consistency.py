"""Consistency checks for the hand-written `close` source skill.

`skills/close/SKILL.md` is tracked source — a thin, content-blind coordinator
for the epic-close phase (it is NOT template-generated; do not look for a
`close.md.tmpl`). This module mirrors `test_work_skill_consistency.py` to guard
the skill against verb-drift and stale-agentId regressions and to pin the
coordinator's load-bearing process contracts:

1. **Verb existence** — every `planctl <verb>` invocation inside a fenced bash
   block must resolve to a real CLI command (the verb-existence guard). The close skill
   uses `--file -` heredoc verbs (`audit submit` / `verdict submit` /
   `followup submit`); the extractor pulls only the verb path and the test
   invokes `<verb> --help`, so the heredoc body is never executed.

2. **agentId regex** — the QUESTION warm-resume path captures the planner's
   `agentId:` from the Task tool result with ``re.search`` (not ``re.match`` —
   the result string has content before `agentId:`). This pins the contract.

3. **Coordinator invariants** — blind spawns carry no `model=` kwarg, the
   CloseOutcome switch is total over the four members, and no stale pointers
   (version-pinned model ids, `<VERDICT_JSON>`, `classifier`, the hookctl
   session_naming path) survive.

All CLI invocations route through the shared ``run_cli`` invoker.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from .conftest import run_cli

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_REPO_ROOT: Path = Path(__file__).resolve().parents[1]
_CLOSE_SKILL: Path = _REPO_ROOT / "skills" / "close" / "SKILL.md"

# Multi-word verb prefixes the planctl CLI exposes as nested Click groups.
# When extracting a verb from `planctl <words...>`, if the first word is one of
# these, we keep both words as the argv; otherwise we keep just the first.
# The close skill's submit verbs live under the `audit` / `verdict` / `followup`
# groups, so they extend the base set sourced from work_skill_consistency.
_MULTIWORD_PREFIXES: frozenset[str] = frozenset(
    {
        "epic",
        "task",
        "worker",
        "dep",
        "config",
        "audit",
        "verdict",
        "followup",
    }
)


# ---------------------------------------------------------------------------
# Existence + frontmatter
# ---------------------------------------------------------------------------


def test_close_skill_exists():
    """The close skill must exist as tracked source at the documented path."""
    assert _CLOSE_SKILL.is_file(), (
        f"{_CLOSE_SKILL} missing — close is hand-written tracked source, NOT a "
        "generated render; there is no `close.md.tmpl`. Restore the file."
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
        while i < len(lines) and (
            lines[i].startswith(" ") or lines[i].startswith("\t")
        ):
            value_parts.append(lines[i].strip())
            i += 1
        fm[key] = "\n".join(value_parts).strip()
    return fm


def test_close_skill_name_is_bare_close():
    """`name:` must be the bare verb `close` — no `plan:` prefix on the
    hand-written source skill.
    """
    fm = _parse_frontmatter_keys(_read_frontmatter_block(_CLOSE_SKILL))
    assert fm.get("name") == "close", fm


# ---------------------------------------------------------------------------
# Group A — Verb existence guard
# ---------------------------------------------------------------------------


def _extract_planctl_verbs(skill_text: str) -> list[tuple[str, ...]]:
    """Extract every `planctl <verb>` invocation from fenced bash blocks.

    Heredoc-safe: the close skill pipes payloads into `--file -` verbs via
    quoted heredocs. We scan fenced ```bash blocks line-by-line and pull only
    the `planctl <word> [<word> ...]` verb path — flags (`--file`), the `-`
    stdin token, placeholders (`<epic_id>`), and the heredoc body lines never
    contribute a verb (heredoc body lines don't start with `planctl`). The
    parametrized test then invokes `<verb> --help`, so no heredoc is ever
    executed.
    """
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
    if _CLOSE_SKILL.is_file():
        return _extract_planctl_verbs(_CLOSE_SKILL.read_text())
    return []


_VERBS: list[tuple[str, ...]] = _all_verbs()


def test_extracted_verbs_nonempty():
    """Sanity: at least one verb surfaces from the close skill's bash blocks.

    If this fires, the fenced-bash scanner regressed and the parametrized test
    below would silently pass with zero parameters.
    """
    assert len(_VERBS) > 0, (
        "no planctl verbs extracted from close/SKILL.md — either the file is "
        "missing or the fenced-bash extractor regressed."
    )


@pytest.mark.parametrize(
    "verb_parts",
    _VERBS,
    ids=lambda parts: "planctl-" + "-".join(parts),
)
def test_close_skill_planctl_verbs_have_help(verb_parts: tuple[str, ...]):
    """Every `planctl <verb>` referenced in a fenced bash block of the close
    skill must respond to `--help` with exit code 0 — i.e. it exists in the
    CLI surface. Mirrors the verb-existence / agentId-regex guard.

    ``--help`` short-circuits the command body, so the heredoc-fed `--file -`
    submit verbs are validated for existence without ever reading stdin.
    """
    result = run_cli([*verb_parts, "--help"])
    assert result.exit_code == 0, (
        f"planctl {' '.join(verb_parts)} --help failed:\n{result.output}"
    )


# ---------------------------------------------------------------------------
# Group B — agentId regex (QUESTION warm-resume capture)
# ---------------------------------------------------------------------------

# Frozen contract: the regex the close skill uses to capture the close-planner's
# agent_id from the Task tool result string for the QUESTION warm-resume path.
AGENT_ID_PATTERN: re.Pattern[str] = re.compile(r"agentId:\s*([a-f0-9]{10,})")

_AGENT_ID_SAMPLE: str = (
    "QUESTION pending.\n"
    "agentId: a1b2c3d4e5f6 (use SendMessage with to: 'a1b2c3d4e5f6' "
    "to continue this agent)"
)


def test_agentid_regex_matches_task_tool_result():
    """`re.search` against the frozen sample captures the hex agent_id."""
    m = AGENT_ID_PATTERN.search(_AGENT_ID_SAMPLE)
    assert m is not None, "regex failed to find agentId in sample string"
    assert m.group(1) == "a1b2c3d4e5f6"


def test_agentid_regex_requires_search_not_match():
    """`re.match` has an implicit `^` and returns None on the sample (which has
    content before `agentId:`). The QUESTION warm-resume contract is
    `re.search`, not `re.match` — this assertion pins it.
    """
    assert AGENT_ID_PATTERN.match(_AGENT_ID_SAMPLE) is None, (
        "re.match unexpectedly matched — sample must have content before "
        "`agentId:` so the regex contract stays `re.search`"
    )


def test_close_skill_pins_agentid_regex():
    """The skill must name the `agentId:\\s*([a-f0-9]{10,})` capture so the
    QUESTION warm-resume path can address the pinned planner agent.
    """
    text = _CLOSE_SKILL.read_text()
    assert r"agentId:\s*([a-f0-9]{10,})" in text, (
        "close/SKILL.md does not pin the agentId capture regex — the QUESTION "
        "warm-resume path needs it to capture the close-planner's agent_id."
    )


# ---------------------------------------------------------------------------
# Group C — Blind spawns: no `model=` kwarg
# ---------------------------------------------------------------------------


def _extract_task_call_blocks(text: str) -> list[str]:
    """Return each `Task(...)` literal block (paren-depth bounded).

    Mirrors `test_work_skill_consistency._extract_task_call_blocks`: we bound on
    Python call syntax, not a line window, so prose like "no `model=` kwarg"
    outside the call never leaks into the captured block.
    """
    lines = text.splitlines()
    blocks: list[str] = []
    i = 0
    while i < len(lines):
        if "Task(" not in lines[i]:
            i += 1
            continue
        depth = 0
        start = i
        captured: list[str] = []
        while i < len(lines):
            captured.append(lines[i])
            depth += lines[i].count("(") - lines[i].count(")")
            i += 1
            if depth <= 0 and start != i - 1:
                break
            if depth <= 0:
                break
        blocks.append("\n".join(captured))
    return blocks


def test_close_skill_spawns_are_blind_no_model_kwarg():
    """Both agent spawns (quality-auditor + close-planner) must be config-only
    and carry NO `model=` kwarg — the agent files own the model and effort.
    """
    text = _CLOSE_SKILL.read_text()
    blocks = _extract_task_call_blocks(text)
    assert len(blocks) >= 2, (
        "close/SKILL.md must carry at least two Task(...) spawn blocks "
        f"(quality-auditor + close-planner); found {len(blocks)}."
    )
    spawned = {
        kind
        for kind in ("quality-auditor", "close-planner")
        if any(kind in b for b in blocks)
    }
    assert spawned == {"quality-auditor", "close-planner"}, (
        "close/SKILL.md must spawn BOTH the quality-auditor and the "
        f"close-planner; found spawns for {sorted(spawned)}."
    )
    # Keeper launches /plan:close against the globally-loaded `plan` plugin
    # with no --plugin-dir, so both agents resolve ONLY under their namespaced
    # ids. A bare `subagent_type="quality-auditor"` wedges autopilot in a
    # re-dispatch loop. Mirror work's `plan:worker-<tier>`.
    for kind in ("quality-auditor", "close-planner"):
        assert f'subagent_type="plan:{kind}"' in text, (
            f"close/SKILL.md must spawn `{kind}` under its namespaced id "
            f'`plan:{kind}` — bare `subagent_type="{kind}"` does not resolve '
            "when keeper launches /plan:close against the global plan plugin."
        )
    for block in blocks:
        assert "model=" not in block, (
            "close/SKILL.md Task(...) spawn carries a `model=` kwarg — the "
            f"agent file owns the model. Block:\n{block}"
        )


# ---------------------------------------------------------------------------
# Group D — CloseOutcome switch is total; no stale pointers
# ---------------------------------------------------------------------------


def test_close_skill_switch_is_total_over_close_outcome():
    """The skill's finalize switch must name every CloseOutcome member, and the
    set must equal the live `CloseOutcome` enum (total switch — the
    exhaustiveness contract). If an outcome is added to the enum, this test
    fails until the skill grows the matching arm.
    """
    from planctl.run_close_finalize import CloseOutcome

    text = _CLOSE_SKILL.read_text()
    enum_values = {m.value for m in CloseOutcome}
    named = {v for v in enum_values if f"`{v}`" in text}
    assert named == enum_values, (
        "close/SKILL.md finalize switch is not total over CloseOutcome: "
        f"enum has {sorted(enum_values)}, skill names {sorted(named)}. "
        f"Missing arm(s): {sorted(enum_values - named)}."
    )


def test_close_skill_has_no_stale_pointers():
    """No version-pinned model ids, no retired `<VERDICT_JSON>` / `classifier`
    references, and no stale hookctl session_naming pointer survive in the
    coordinator (house rule: present-tense, forward-facing prose only).
    """
    text = _CLOSE_SKILL.read_text()
    forbidden = [
        "claude-opus-4-5",
        "claude-sonnet-4-6",
        "<VERDICT_JSON>",
        "classifier",
        "session_naming",
        "hookctl",
    ]
    hits = [needle for needle in forbidden if needle in text]
    assert not hits, (
        f"close/SKILL.md carries retired/stale references {hits} — the close "
        "coordinator is content-blind: no version-pinned model ids, no "
        "`<VERDICT_JSON>` extraction, no `classifier` agent, no hookctl "
        "session_naming pointer."
    )
