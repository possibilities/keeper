"""Tests pinning the ``PLANCTL_NOW`` clock-override contract.

``now_iso()`` honors ``PLANCTL_NOW`` as a cross-implementation contract: a
valid value is returned verbatim, a malformed value is a hard error, and an
unset variable preserves the wall-clock default. The accepted format string is
pinned here so any drift fails loudly — the future Bun implementation is held
to the identical contract.
"""

from __future__ import annotations

import json
import re

import pytest
from planctl.store import _NOW_ISO_FORMAT, now_iso

from .conftest import seed_epic

_FROZEN = "2026-06-06T12:34:56.000007Z"


def test_format_string_is_pinned():
    """Contract drift on the accepted format fails loudly."""
    assert _NOW_ISO_FORMAT == "%Y-%m-%dT%H:%M:%S.%fZ"


def test_unset_returns_wall_clock(monkeypatch):
    monkeypatch.delenv("PLANCTL_NOW", raising=False)
    value = now_iso()
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z", value)


def test_set_and_valid_returns_verbatim(monkeypatch):
    monkeypatch.setenv("PLANCTL_NOW", _FROZEN)
    assert now_iso() == _FROZEN


@pytest.mark.parametrize(
    "bad",
    [
        "2026-06-06T12:34:56Z",  # no microseconds
        "2026-06-06 12:34:56.000007Z",  # space, not T
        "2026-06-06T12:34:56.000007",  # missing trailing Z
        "not-a-timestamp",
        "",
    ],
)
def test_malformed_is_hard_error(monkeypatch, bad):
    monkeypatch.setenv("PLANCTL_NOW", bad)
    with pytest.raises(ValueError, match="PLANCTL_NOW"):
        now_iso()


def test_boundary_stamped_field_equals_frozen_value(project):
    """A timestamp-writing verb stamps the frozen value end-to-end.

    The conformance engine relies on this path transitively: with ``PLANCTL_NOW``
    in the invocation env, ``scaffold`` stamps ``last_validated_at`` verbatim.
    """
    epic_id, _ = seed_epic(project, env={"PLANCTL_NOW": _FROZEN})
    epic_path = project / ".planctl" / "epics" / f"{epic_id}.json"
    data = json.loads(epic_path.read_text())
    assert data["last_validated_at"] == _FROZEN
