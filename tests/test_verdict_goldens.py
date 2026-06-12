"""Sync-guard for the verdict-reject golden corpus.

``tests/fixtures/golden/verdict/*.json`` is the parity table the bun port's
hand-rolled verdict validator targets: one ``VERDICT_INVALID`` reject envelope
per schema keyword (``required``, ``additionalProperties``, ``type``,
``minLength``, ``pattern``) and per cross-field invariant
(``dangling_merge_target``, ``culled_task_not_null``, ``task_ordinal_required``,
``fatal_reason_required``). The message text in each ``{loc, type, msg}`` row is
the load-bearing parity surface — python-jsonschema's exact wording — so the
bun engine reads these goldens and must reproduce them byte-for-byte.

This guard asserts the LIVE Python validator still produces the committed
goldens: if jsonschema's wording shifts or a message is edited without
regenerating, this fails loudly rather than letting the bun parity target drift
silently. Pure functions only (no CLI, no engine seam) — the goldens themselves
are what `tests/test_verdict_submit.py` and the bun conformance run consume.

Regenerate with ``uv run python tests/fixtures/golden/verdict/_generate.py``.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_GOLDEN_DIR = Path(__file__).parent / "fixtures" / "golden" / "verdict"


def _load_generator():
    """Import the corpus generator by file path (no fixtures package needed)."""
    spec = importlib.util.spec_from_file_location(
        "verdict_golden_generate", _GOLDEN_DIR / "_generate.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


_GEN = _load_generator()

#: The schema keywords + cross-field rule types the corpus must cover. A new
#: validator rule without a golden is a coverage gap this set catches.
_EXPECTED_TYPES = {
    "schema_required": "required",
    "schema_additional_properties": "additionalProperties",
    "schema_type": "type",
    "schema_min_length": "minLength",
    "schema_pattern": "pattern",
    "cross_dangling_merge_target": "dangling_merge_target",
    "cross_culled_task_not_null": "culled_task_not_null",
    "cross_task_ordinal_required": "task_ordinal_required",
    "cross_fatal_reason_required": "fatal_reason_required",
}


def test_corpus_covers_every_rule():
    """Every schema keyword + cross-field rule has exactly one golden case."""
    assert set(_GEN.CASES) == set(_EXPECTED_TYPES)


@pytest.mark.parametrize("name", sorted(_EXPECTED_TYPES))
def test_golden_matches_live_validator(name):
    """Each committed golden is byte-identical to the live validator's output."""
    golden_path = _GOLDEN_DIR / f"{name}.json"
    assert golden_path.exists(), f"missing golden {golden_path}"
    assert golden_path.read_text(encoding="utf-8") == _GEN.render(name)


@pytest.mark.parametrize("name", sorted(_EXPECTED_TYPES))
def test_golden_isolates_one_rule(name):
    """Each golden trips exactly one rule, of the expected type, error_count 1."""
    data = json.loads((_GOLDEN_DIR / f"{name}.json").read_text(encoding="utf-8"))
    details = data["envelope"]["error"]["details"]
    assert data["envelope"]["error"]["code"] == "VERDICT_INVALID"
    assert details["error_count"] == 1
    assert len(details["errors"]) == 1
    assert details["errors"][0]["type"] == _EXPECTED_TYPES[name]
