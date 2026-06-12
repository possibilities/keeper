"""Regenerate the verdict-reject golden corpus from the live Python validator.

The corpus is the parity table the bun port's hand-rolled validator targets:
one VERDICT_INVALID envelope per schema keyword in play (``required``,
``additionalProperties``, ``type``, ``minLength``, ``pattern``) plus each
cross-field invariant (``dangling_merge_target``, ``culled_task_not_null``,
``task_ordinal_required``, ``fatal_reason_required``). Each input is crafted to
trip EXACTLY ONE rule so the captured ``{loc, type, msg}`` row is unambiguous —
the message text is the load-bearing parity surface (python-jsonschema's exact
wording, e.g. ``'' should be non-empty``).

Run from the repo root: ``uv run python tests/fixtures/golden/verdict/_generate.py``.
``test_verdict_goldens.py`` then asserts the live functions still reproduce these
bytes, so a divergence (jsonschema bump, message edit) fails loudly here.
"""

from __future__ import annotations

import json
from pathlib import Path

from planctl.verdict_schema import (
    build_reject_envelope,
    cross_field_errors,
    schema_errors,
)

_DIR = Path(__file__).parent


def _base() -> dict:
    return {"fatal": False, "fatal_reason": "", "decisions": []}


def _dec(**kw) -> dict:
    d = {"fid": "f1", "action": "kept", "task": 1, "rationale": "r"}
    d.update(kw)
    return d


#: name -> input verdict, each crafted to trip exactly one rule.
CASES: dict[str, dict] = {
    # Schema-keyword failures (structural pass).
    "schema_required": {"fatal": False, "fatal_reason": ""},
    "schema_additional_properties": {**_base(), "bogus": 1},
    "schema_type": {**_base(), "fatal": "nope"},
    "schema_min_length": {**_base(), "decisions": [_dec(fid="")]},
    "schema_pattern": {**_base(), "decisions": [_dec(action="bogus-action")]},
    # Cross-field failures (each is structurally valid first).
    "cross_dangling_merge_target": {
        **_base(),
        "decisions": [_dec(action="merged-into-nope", task=1)],
    },
    "cross_culled_task_not_null": {
        **_base(),
        "decisions": [_dec(action="culled", task=3)],
    },
    "cross_task_ordinal_required": {
        **_base(),
        "decisions": [_dec(action="kept", task=None)],
    },
    "cross_fatal_reason_required": {**_base(), "fatal": True, "fatal_reason": "   "},
}


def envelope_for(verdict: dict) -> dict:
    errors = schema_errors(verdict)
    if not errors:
        errors = cross_field_errors(verdict)
    return build_reject_envelope(errors)


def render(name: str) -> str:
    verdict = CASES[name]
    payload = {"input": verdict, "envelope": envelope_for(verdict)}
    return json.dumps(payload, indent=2, sort_keys=True) + "\n"


def main() -> None:
    for name in CASES:
        (_DIR / f"{name}.json").write_text(render(name), encoding="utf-8")
        print(f"wrote {name}.json")


if __name__ == "__main__":
    main()
