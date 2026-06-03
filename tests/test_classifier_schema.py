"""Tests for classifier verdict JSON schema validation."""

from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError as SchemaValidationError
from jsonschema.exceptions import best_match

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_SCHEMA_PATH = (
    Path(__file__).parent.parent / "skills" / "close" / "classifier" / "schema.json"
)

_FIXTURES_DIR = Path(__file__).parent / "fixtures" / "classifier"


def _load_schema() -> dict:
    return json.loads(_SCHEMA_PATH.read_text())


def _load_fixture(name: str) -> dict:
    return json.loads((_FIXTURES_DIR / name).read_text())


def _validate(data: dict) -> list[SchemaValidationError]:
    schema = _load_schema()
    validator = Draft202012Validator(schema)
    return list(validator.iter_errors(data))


def _is_valid(data: dict) -> bool:
    return len(_validate(data)) == 0


# ---------------------------------------------------------------------------
# Schema self-check
# ---------------------------------------------------------------------------


def test_schema_is_valid_json_schema():
    """The schema itself is a valid JSON Schema Draft 2020-12 document."""
    schema = _load_schema()
    Draft202012Validator.check_schema(schema)


# ---------------------------------------------------------------------------
# Happy path: valid verdicts pass
# ---------------------------------------------------------------------------


def test_valid_clean_passes():
    """Well-formed verdict with fatal: false, populated tier_1, empty others — passes."""
    data = _load_fixture("valid_clean.json")
    assert _is_valid(data), _validate(data)


def test_valid_fatal_passes():
    """fatal: true + non-empty fatal_reason + populated tier_2 + empty tier_1 — passes."""
    data = _load_fixture("valid_fatal.json")
    assert data["fatal"] is True
    assert data["fatal_reason"] != ""
    assert data["tier_1"] == []
    assert len(data["tier_2"]) > 0
    assert _is_valid(data), _validate(data)


def test_valid_populated_passes():
    """Verdict with findings in multiple tiers — passes."""
    data = _load_fixture("valid_populated.json")
    assert _is_valid(data), _validate(data)


def test_empty_tier_arrays_are_valid():
    """All tier arrays may be empty — minItems is not set."""
    verdict = {
        "fatal": False,
        "fatal_reason": "",
        "tier_0": [],
        "tier_1": [],
        "tier_2": [],
        "tier_3": [],
    }
    assert _is_valid(verdict)


def test_fatal_false_with_empty_fatal_reason_is_valid():
    """fatal_reason may be empty string when fatal is false."""
    verdict = {
        "fatal": False,
        "fatal_reason": "",
        "tier_0": [],
        "tier_1": [],
        "tier_2": [],
        "tier_3": [],
    }
    assert _is_valid(verdict)


# ---------------------------------------------------------------------------
# Reject malformed verdicts
# ---------------------------------------------------------------------------


def test_reject_fatal_as_string():
    """fatal: 'yes' (string) must fail — type mismatch."""
    data = _load_fixture("invalid_wrong_type.json")
    errors = _validate(data)
    assert len(errors) > 0


def test_reject_extra_field_in_finding():
    """Finding with extra field 'notes' must fail — additionalProperties: false."""
    data = _load_fixture("invalid_extra_field.json")
    errors = _validate(data)
    assert len(errors) > 0


def test_reject_empty_severity_reason():
    """Finding with severity_reason: '' must fail — minLength: 1."""
    data = _load_fixture("invalid_empty_string.json")
    errors = _validate(data)
    assert len(errors) > 0


def test_reject_missing_evidence_field():
    """Finding without 'evidence' must fail — required."""
    data = _load_fixture("invalid_missing_field.json")
    errors = _validate(data)
    assert len(errors) > 0


def test_reject_missing_tier_2_top_level():
    """Verdict without 'tier_2' must fail — required."""
    data = _load_fixture("invalid_missing_top_level.json")
    assert "tier_2" not in data
    errors = _validate(data)
    assert len(errors) > 0


def test_reject_extra_top_level_field():
    """Verdict with unexpected top-level field must fail — additionalProperties: false."""
    verdict = {
        "fatal": False,
        "fatal_reason": "",
        "tier_0": [],
        "tier_1": [],
        "tier_2": [],
        "tier_3": [],
        "unexpected_field": "oops",
    }
    errors = _validate(verdict)
    assert len(errors) > 0


def test_reject_finding_with_empty_id():
    """Finding with id: '' must fail — minLength: 1."""
    verdict = {
        "fatal": False,
        "fatal_reason": "",
        "tier_0": [],
        "tier_1": [
            {
                "id": "",
                "title": "Some title",
                "summary": "A summary",
                "rationale": "A rationale",
                "severity_reason": "A severity reason",
                "affected_paths": ["apps/planctl/planctl/cli.py"],
                "evidence": "cli.py:10",
                "suggested_fix": "Fix it",
            }
        ],
        "tier_2": [],
        "tier_3": [],
    }
    errors = _validate(verdict)
    assert len(errors) > 0


def test_reject_affected_paths_not_array():
    """affected_paths must be an array — not a string."""
    verdict = {
        "fatal": False,
        "fatal_reason": "",
        "tier_0": [],
        "tier_1": [
            {
                "id": "F1",
                "title": "Some title",
                "summary": "A summary",
                "rationale": "A rationale",
                "severity_reason": "A severity reason",
                "affected_paths": "apps/planctl/planctl/cli.py",
                "evidence": "cli.py:10",
                "suggested_fix": "Fix it",
            }
        ],
        "tier_2": [],
        "tier_3": [],
    }
    errors = _validate(verdict)
    assert len(errors) > 0


# ---------------------------------------------------------------------------
# best_match produces actionable string
# ---------------------------------------------------------------------------


def test_best_match_returns_actionable_string():
    """best_match() on validation errors returns a non-empty, printable string."""
    data = _load_fixture("invalid_wrong_type.json")
    errors = _validate(data)
    assert len(errors) > 0
    match = best_match(errors)
    assert match is not None
    msg = str(match.message)
    assert len(msg) > 0
    # Should mention 'yes' or 'boolean' or 'string' — something useful
    assert any(term in msg for term in ("'yes'", "boolean", "string", "is not of type"))


def test_best_match_on_missing_required_field():
    """best_match() on missing required field names the field."""
    data = _load_fixture("invalid_missing_field.json")
    errors = _validate(data)
    match = best_match(errors)
    assert match is not None
    msg = str(match.message)
    assert len(msg) > 0


def test_best_match_on_extra_property():
    """best_match() on additionalProperties violation names the extra field."""
    data = _load_fixture("invalid_extra_field.json")
    errors = _validate(data)
    match = best_match(errors)
    assert match is not None
    msg = str(match.message)
    assert len(msg) > 0
    assert "notes" in msg or "Additional" in msg


# ---------------------------------------------------------------------------
# Fixture integrity check
# ---------------------------------------------------------------------------


def test_all_valid_fixtures_pass():
    """All valid_*.json fixtures validate against the schema."""
    valid_fixtures = list(_FIXTURES_DIR.glob("valid_*.json"))
    assert len(valid_fixtures) >= 3, "Expected at least 3 valid fixtures"
    for fixture_path in valid_fixtures:
        data = json.loads(fixture_path.read_text())
        errors = _validate(data)
        assert errors == [], f"{fixture_path.name} failed: {errors}"


def test_all_invalid_fixtures_fail():
    """All invalid_*.json fixtures fail schema validation."""
    invalid_fixtures = list(_FIXTURES_DIR.glob("invalid_*.json"))
    assert len(invalid_fixtures) >= 5, "Expected at least 5 invalid fixtures"
    for fixture_path in invalid_fixtures:
        data = json.loads(fixture_path.read_text())
        errors = _validate(data)
        assert errors != [], f"{fixture_path.name} should have failed but passed"
