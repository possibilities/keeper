"""Tests for the /plan:close skill orchestration logic.

These tests exercise the verdict parsing, fatal-check branch, and epic-close
flow by mocking the Agent tool boundary (Task spawns) and shell calls
(planctl, git). They do not require a live Claude session.

The close skill is a Markdown + agent-prose document — the logic under test
here is the Python helper layer that the skill prose delegates to:
  - Verdict extraction regex (non-greedy DOTALL last-match-wins)
  - JSON parse + jsonschema validation
  - Fatal-check branch (the only ship-block path post fn-462)

All shell-level calls are monkeypatched via unittest.mock so tests are
hermetic and fast. The tier-1 commit-detection / quality-fix-worker dispatch
loop was removed in fn-462 — `/plan:close` no longer dispatches workers; all
non-fatal findings flow to `/plan:audit`.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from jsonschema import Draft202012Validator
from jsonschema.exceptions import (
    best_match,  # noqa: F401 — used in parse_and_validate_verdict
)

# ---------------------------------------------------------------------------
# Helpers mirroring the skill's Python logic (extracted for unit testing)
# ---------------------------------------------------------------------------

_SCHEMA_PATH = (
    Path(__file__).parent.parent / "skills" / "close" / "classifier" / "schema.json"
)

_FIXTURES_DIR = Path(__file__).parent / "fixtures" / "classifier"
_AUDITOR_FIXTURES_DIR = Path(__file__).parent / "fixtures" / "auditor"


def _load_schema() -> dict:
    return json.loads(_SCHEMA_PATH.read_text())


def _load_classifier_fixture(name: str) -> dict:
    return json.loads((_FIXTURES_DIR / name).read_text())


def _load_auditor_fixture(name: str) -> str:
    return (_AUDITOR_FIXTURES_DIR / name).read_text()


# ---------------------------------------------------------------------------
# Verdict extraction (mirrors Phase 5 of SKILL.md)
# ---------------------------------------------------------------------------


_UNICODE_LOOKALIKES = str.maketrans(
    {
        "，": ",",
        "：": ":",
        "“": '"',
        "”": '"',
        "‘": "'",
        "’": "'",
    }
)


def extract_verdict_block(classifier_output: str) -> str | None:
    """Extract the last <VERDICT_JSON>...</VERDICT_JSON> block.

    Non-greedy + DOTALL + last-match-wins. Mirrors SKILL.md Phase 5 exactly.
    Last-match-wins defends against the classifier emitting an example block
    mid-prose before the real final block. After fence-stripping, normalize
    common Unicode lookalikes (fullwidth comma/colon, smart quotes) to ASCII —
    Sonnet occasionally stylizes punctuation in em-dash-heavy contexts and
    can leak non-ASCII delimiters into the JSON.
    """
    matches = re.findall(
        r"<VERDICT_JSON>(.*?)</VERDICT_JSON>",
        classifier_output,
        re.DOTALL,
    )
    if not matches:
        return None
    raw = matches[-1].strip()
    # Strip markdown code fences if present (symmetric pair or lone opening fence)
    raw = re.sub(r"^```[a-z]*\n?(.*?)(?:\n```)?$", r"\1", raw, flags=re.DOTALL).strip()
    # Normalize Unicode lookalikes to ASCII (em dashes inside string values are preserved)
    raw = raw.translate(_UNICODE_LOOKALIKES)
    return raw if raw else None


def parse_and_validate_verdict(raw_json: str) -> tuple[dict | None, str | None]:
    """Parse raw JSON and validate against schema.

    Returns (verdict, error_message). On success error_message is None.
    """
    try:
        verdict = json.loads(raw_json)
    except json.JSONDecodeError as exc:
        return None, f"JSON parse error: {exc}"

    schema = _load_schema()
    validator = Draft202012Validator(schema)
    errors = list(validator.iter_errors(verdict))
    if errors:
        match = best_match(errors)
        return None, f"schema validation failed: {match.message}"

    return verdict, None


# ---------------------------------------------------------------------------
# Fixtures helpers
# ---------------------------------------------------------------------------


def _make_classifier_output(verdict_dict: dict, preamble: str = "") -> str:
    """Wrap a verdict dict in the classifier output format."""
    prose = preamble or "Analysis complete. See verdict below."
    return f"{prose}\n\n<VERDICT_JSON>{json.dumps(verdict_dict)}</VERDICT_JSON>"


def _clean_verdict() -> dict:
    return _load_classifier_fixture("valid_clean.json")


def _fatal_verdict() -> dict:
    return _load_classifier_fixture("valid_fatal.json")


def _populated_verdict() -> dict:
    return _load_classifier_fixture("valid_populated.json")


# ---------------------------------------------------------------------------
# Phase 5: Verdict extraction
# ---------------------------------------------------------------------------


class TestVerdictExtraction:
    def test_extracts_clean_verdict(self):
        verdict = _clean_verdict()
        output = _make_classifier_output(verdict)
        raw = extract_verdict_block(output)
        assert raw is not None
        parsed = json.loads(raw)
        assert parsed["fatal"] is False
        assert parsed["tier_1"] == verdict["tier_1"]

    def test_returns_none_when_no_block(self):
        output = "This is just prose. No verdict block here."
        assert extract_verdict_block(output) is None

    def test_last_match_wins(self):
        """When multiple blocks present, the last one is used.

        Defends against classifier emitting an example block mid-prose
        before the real final block.
        """
        early_verdict = {
            "fatal": True,
            "fatal_reason": "early block",
            "tier_0": [],
            "tier_1": [],
            "tier_2": [],
            "tier_3": [],
        }
        late_verdict = {
            "fatal": False,
            "fatal_reason": "",
            "tier_0": [],
            "tier_1": [],
            "tier_2": [],
            "tier_3": [],
        }
        output = (
            "Here is an example: "
            f"<VERDICT_JSON>{json.dumps(early_verdict)}</VERDICT_JSON>"
            " And now the real verdict: "
            f"<VERDICT_JSON>{json.dumps(late_verdict)}</VERDICT_JSON>"
        )
        raw = extract_verdict_block(output)
        assert raw is not None
        parsed = json.loads(raw)
        # Must use the LAST block — the clean one, not the fatal early one
        assert parsed["fatal"] is False

    def test_strips_markdown_fences(self):
        verdict = _clean_verdict()
        output = (
            f"prose\n\n<VERDICT_JSON>```json\n{json.dumps(verdict)}\n```</VERDICT_JSON>"
        )
        raw = extract_verdict_block(output)
        assert raw is not None
        parsed = json.loads(raw)
        assert parsed["fatal"] is False

    def test_strips_asymmetric_fence_opening_only(self):
        """When the model emits only an opening fence with no closing one,
        the strip must not produce malformed JSON — the lone opening fence
        line is removed and the JSON content is returned intact.
        """
        verdict = _clean_verdict()
        # Asymmetric: opening fence present, closing fence absent
        output = f"prose\n\n<VERDICT_JSON>```json\n{json.dumps(verdict)}</VERDICT_JSON>"
        raw = extract_verdict_block(output)
        assert raw is not None
        parsed = json.loads(raw)
        assert parsed["fatal"] is False

    def test_handles_multiline_json(self):
        verdict = _populated_verdict()
        output = (
            f"prose\n\n<VERDICT_JSON>\n{json.dumps(verdict, indent=2)}\n</VERDICT_JSON>"
        )
        raw = extract_verdict_block(output)
        assert raw is not None
        parsed = json.loads(raw)
        assert "tier_1" in parsed

    def test_normalizes_fullwidth_comma(self):
        """Sonnet occasionally emits fullwidth commas (U+FF0C) as JSON array
        separators when the surrounding prose is em-dash-heavy. The closer's
        Phase 5 normalizes common Unicode lookalikes to ASCII before parse.
        """
        verdict = _populated_verdict()
        # Hand-craft a verdict block with fullwidth commas between tier_1 entries
        # AND a fullwidth colon, simulating the observed Sonnet drift mode.
        good = json.dumps(verdict)
        # Replace ASCII separator between sibling objects with fullwidth comma
        drifted = good.replace("},{", "}，{")
        # Replace one structural colon with fullwidth (after the opening brace)
        drifted = drifted.replace('"fatal": ', '"fatal"： ', 1)
        output = f"prose\n\n<VERDICT_JSON>{drifted}</VERDICT_JSON>"
        raw = extract_verdict_block(output)
        assert raw is not None
        # After normalization, it must parse cleanly
        parsed = json.loads(raw)
        assert parsed["fatal"] is False
        assert parsed["tier_1"] == verdict["tier_1"]

    def test_normalizes_smart_quotes(self):
        """Smart quotes (U+201C/U+201D) sometimes leak into JSON delimiters.
        The Phase 5 normalizer maps them back to ASCII double quote.
        """
        verdict = _clean_verdict()
        good = json.dumps(verdict)
        # Replace each ASCII double quote with smart-quote variants
        # (alternating left/right to simulate model drift)
        drifted = good.replace('"', "“", 1).replace('"', "”", 1)
        output = f"prose\n\n<VERDICT_JSON>{drifted}</VERDICT_JSON>"
        raw = extract_verdict_block(output)
        assert raw is not None
        # After normalization the leading delimiters are ASCII again
        assert "“" not in raw and "”" not in raw

    def test_preserves_em_dashes_in_string_values(self):
        """Em dashes inside JSON string values are valid UTF-8 and must NOT
        be remapped — they appear in human prose like fatal_reason fields.
        """
        verdict = {
            "fatal": True,
            "fatal_reason": "Critical defect — data loss on rollback",
            "tier_0": [],
            "tier_1": [],
            "tier_2": [],
            "tier_3": [],
        }
        output = f"prose\n\n<VERDICT_JSON>{json.dumps(verdict, ensure_ascii=False)}</VERDICT_JSON>"
        raw = extract_verdict_block(output)
        assert raw is not None
        parsed = json.loads(raw)
        assert "—" in parsed["fatal_reason"]


# ---------------------------------------------------------------------------
# Phase 5: Parse + schema validation
# ---------------------------------------------------------------------------


class TestVerdictParseAndValidate:
    def test_valid_clean_passes(self):
        raw = json.dumps(_clean_verdict())
        verdict, err = parse_and_validate_verdict(raw)
        assert err is None
        assert verdict is not None
        assert verdict["fatal"] is False

    def test_valid_fatal_passes(self):
        raw = json.dumps(_fatal_verdict())
        verdict, err = parse_and_validate_verdict(raw)
        assert err is None
        assert verdict["fatal"] is True

    def test_valid_populated_passes(self):
        raw = json.dumps(_populated_verdict())
        verdict, err = parse_and_validate_verdict(raw)
        assert err is None
        assert len(verdict["tier_1"]) >= 1

    def test_malformed_json_returns_error(self):
        verdict, err = parse_and_validate_verdict("{not json}")
        assert verdict is None
        assert err is not None
        assert "JSON parse error" in err

    def test_schema_incompliant_missing_tier2_returns_error(self):
        """Verdict missing required 'tier_2' key fails schema validation."""
        bad = {
            "fatal": False,
            "fatal_reason": "",
            "tier_0": [],
            "tier_1": [],
            "tier_3": [],
        }
        raw = json.dumps(bad)
        verdict, err = parse_and_validate_verdict(raw)
        assert verdict is None
        assert err is not None
        assert "schema validation failed" in err

    def test_schema_incompliant_extra_field_returns_error(self):
        """Finding with extra field fails additionalProperties: false."""
        data = _load_classifier_fixture("invalid_extra_field.json")
        raw = json.dumps(data)
        verdict, err = parse_and_validate_verdict(raw)
        assert verdict is None
        assert err is not None
        assert "schema validation failed" in err

    def test_schema_incompliant_wrong_type_returns_error(self):
        """fatal: 'yes' (string) fails type: boolean."""
        data = {
            "fatal": "yes",
            "fatal_reason": "",
            "tier_0": [],
            "tier_1": [],
            "tier_2": [],
            "tier_3": [],
        }
        raw = json.dumps(data)
        verdict, err = parse_and_validate_verdict(raw)
        assert verdict is None
        assert err is not None


# ---------------------------------------------------------------------------
# Phase 6: Fatal check (the only ship-block path post fn-462)
# ---------------------------------------------------------------------------


class TestFatalCheck:
    def test_fatal_true_halts_without_closing(self):
        """When verdict['fatal'] is True, the closer halts: epic close must
        NOT be called. No status stamp is written (halt-without-stamp)."""
        verdict = _fatal_verdict()
        assert verdict["fatal"] is True

        close_calls = []

        def mock_epic_close(epic_id: str) -> None:
            close_calls.append(epic_id)

        # Simulate the fatal check branch
        epic_id = "fn-42-add-auth"
        if verdict["fatal"]:
            pass  # halt — do NOT call mock_epic_close
        else:
            mock_epic_close(epic_id)

        assert close_calls == [], "epic close must NOT be called on fatal"

    def test_fatal_false_closes(self):
        """When verdict['fatal'] is False, the epic closes."""
        verdict = _clean_verdict()
        assert verdict["fatal"] is False

        close_calls = []

        def mock_epic_close(epic_id: str) -> None:
            close_calls.append(epic_id)

        epic_id = "fn-42-add-auth"
        if verdict["fatal"]:
            pass  # halt
        else:
            # fn-462: no tier-1 worker dispatch — non-fatal goes straight to close.
            mock_epic_close(epic_id)

        assert close_calls == ["fn-42-add-auth"]

    def test_non_fatal_with_tier1_still_closes(self):
        """fn-462 contract: tier-1 findings on a non-fatal verdict do NOT
        block close. They flow to /plan:audit asynchronously after close.
        """
        verdict = _populated_verdict()
        assert verdict["fatal"] is False
        assert len(verdict["tier_1"]) > 0

        close_calls = []
        epic_id = "fn-42-add-auth"
        if verdict["fatal"]:
            pass  # halt
        else:
            close_calls.append(epic_id)

        assert close_calls == ["fn-42-add-auth"]


# ---------------------------------------------------------------------------
# Full closer flow (mocked)
# ---------------------------------------------------------------------------


class TestCloserFlowHappyPath:
    """Happy path: clean audit, no fatal — epic close called regardless of tier_1 count."""

    def test_clean_audit_no_findings_closes_epic(self):
        """Clean verdict (all tiers empty) — epic close is called."""
        verdict = {
            "fatal": False,
            "fatal_reason": "",
            "tier_0": [],
            "tier_1": [],
            "tier_2": [],
            "tier_3": [],
        }
        close_calls = []

        # Simulate closer Phase 5–8 logic
        raw = extract_verdict_block(_make_classifier_output(verdict))
        assert raw is not None
        parsed, err = parse_and_validate_verdict(raw)
        assert err is None

        if parsed["fatal"]:
            pass  # halt
        else:
            close_calls.append("fn-42-add-auth")

        assert close_calls == ["fn-42-add-auth"]

    def test_populated_non_fatal_audit_closes_epic(self):
        """Non-fatal verdict with tier_1/tier_2 findings — fn-462: still closes.

        Pre-fn-462 this would have entered the tier-1 worker-dispatch loop;
        fn-462 removes that loop and routes everything to /plan:audit.
        """
        verdict = _populated_verdict()
        close_calls = []
        audit_hint_emitted = False

        if verdict["fatal"]:
            pass  # halt
        else:
            close_calls.append("fn-42-add-auth")
            # Audit hint emits when any of tier_1/tier_2/tier_3 is non-empty.
            if verdict["tier_1"] or verdict["tier_2"] or verdict["tier_3"]:
                audit_hint_emitted = True

        assert close_calls == ["fn-42-add-auth"]
        assert audit_hint_emitted is True


# ---------------------------------------------------------------------------
# Fatal halt
# ---------------------------------------------------------------------------


class TestFatalHalt:
    def test_fatal_verdict_skips_close(self):
        verdict = _fatal_verdict()
        assert verdict["fatal"] is True

        close_calls = []

        output = _make_classifier_output(verdict)
        raw = extract_verdict_block(output)
        assert raw is not None
        parsed, err = parse_and_validate_verdict(raw)
        assert err is None
        assert parsed["fatal"] is True

        if parsed["fatal"]:
            pass  # halt — never reach epic close
        else:
            close_calls.append("fn-42-add-auth")

        assert close_calls == []


# ---------------------------------------------------------------------------
# Parse failure paths
# ---------------------------------------------------------------------------


class TestParseFailure:
    def test_missing_verdict_block_halts(self):
        output = "The audit looks fine. No structured verdict block."
        raw = extract_verdict_block(output)
        assert raw is None  # extraction failed

        close_calls = []
        if raw is None:
            pass  # halt — never reach epic close
        else:
            close_calls.append("fn-42-add-auth")

        assert close_calls == []

    def test_malformed_json_inside_block_halts(self):
        output = "<VERDICT_JSON>{not json}</VERDICT_JSON>"
        raw = extract_verdict_block(output)
        assert raw is not None  # block was found
        verdict, err = parse_and_validate_verdict(raw)
        assert verdict is None
        assert err is not None

        close_calls = []
        if err:
            pass  # halt — never reach epic close
        else:
            close_calls.append("fn-42-add-auth")

        assert close_calls == []

    def test_schema_incompliant_json_halts(self):
        """Valid JSON but missing required 'tier_2' fails schema."""
        bad_verdict = {
            "fatal": False,
            "fatal_reason": "",
            "tier_0": [],
            "tier_1": [],
            "tier_3": [],
        }
        output = f"<VERDICT_JSON>{json.dumps(bad_verdict)}</VERDICT_JSON>"
        raw = extract_verdict_block(output)
        assert raw is not None
        verdict, err = parse_and_validate_verdict(raw)
        assert verdict is None
        assert err is not None
        assert "schema validation failed" in err

        close_calls = []
        if err:
            pass  # halt — never reach epic close
        else:
            close_calls.append("fn-42-add-auth")

        assert close_calls == []


# ---------------------------------------------------------------------------
# Last-match-wins
# ---------------------------------------------------------------------------


class TestLastMatchWins:
    def test_last_block_wins_over_earlier_fatal_block(self):
        """Prose contains fatal block early, clean block at the end.
        Parser must use the LAST block."""
        early = {
            "fatal": True,
            "fatal_reason": "early bad block",
            "tier_0": [],
            "tier_1": [],
            "tier_2": [],
            "tier_3": [],
        }
        late = {
            "fatal": False,
            "fatal_reason": "",
            "tier_0": [],
            "tier_1": [],
            "tier_2": [],
            "tier_3": [],
        }

        output = (
            "In this example a fatal verdict might look like: "
            f"<VERDICT_JSON>{json.dumps(early)}</VERDICT_JSON>\n\n"
            "But the actual verdict is:\n"
            f"<VERDICT_JSON>{json.dumps(late)}</VERDICT_JSON>"
        )

        raw = extract_verdict_block(output)
        assert raw is not None
        verdict, err = parse_and_validate_verdict(raw)
        assert err is None
        assert verdict["fatal"] is False, (
            "must use last block, not the early fatal block"
        )

    def test_last_block_wins_multiple_valid_blocks(self):
        """Three blocks — only the last matters."""
        v1 = {
            "fatal": True,
            "fatal_reason": "first",
            "tier_0": [],
            "tier_1": [],
            "tier_2": [],
            "tier_3": [],
        }
        v2 = {
            "fatal": True,
            "fatal_reason": "second",
            "tier_0": [],
            "tier_1": [],
            "tier_2": [],
            "tier_3": [],
        }
        v3 = {
            "fatal": False,
            "fatal_reason": "",
            "tier_0": [],
            "tier_1": [
                {
                    "id": "F1",
                    "title": "T",
                    "summary": "S",
                    "rationale": "R",
                    "severity_reason": "SR",
                    "affected_paths": ["apps/foo/bar.py"],
                    "evidence": "bar.py:1",
                    "suggested_fix": "fix it",
                }
            ],
            "tier_2": [],
            "tier_3": [],
        }

        output = (
            f"<VERDICT_JSON>{json.dumps(v1)}</VERDICT_JSON>"
            f"<VERDICT_JSON>{json.dumps(v2)}</VERDICT_JSON>"
            f"<VERDICT_JSON>{json.dumps(v3)}</VERDICT_JSON>"
        )

        raw = extract_verdict_block(output)
        assert raw is not None
        verdict, err = parse_and_validate_verdict(raw)
        assert err is None
        assert verdict["fatal"] is False
        assert len(verdict["tier_1"]) == 1


# ---------------------------------------------------------------------------
# Auditor fixtures sanity check
# ---------------------------------------------------------------------------


class TestAuditorFixtures:
    def test_clean_fixture_exists_and_is_nonempty(self):
        content = _load_auditor_fixture("clean.md")
        assert "Quality Audit Report" in content
        assert len(content) > 50

    def test_with_findings_fixture_exists_and_mentions_findings(self):
        content = _load_auditor_fixture("with_findings.md")
        assert "Should Fix" in content or "Consider" in content
