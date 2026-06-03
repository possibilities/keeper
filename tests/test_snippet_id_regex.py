"""Pin `SNIPPET_ID_RE` shape — canonical source of the snippet-id constraint.

Task: fn-528-align-plan-phase-1a-snippet-id-regex.1

`/plan` Phase 1a (`apps/planctl/skills/plan/SKILL.md`) mirrors this regex
inline so a `--snippets foo_bar` invocation fails at the planner's front
door, not at Phase 5e via `planctl task set-snippets`.  If this regex
shape changes, update the SKILL.md per-snippet-id assertion in lockstep.
"""

from __future__ import annotations

import pytest
from planctl.bundle_ref import SNIPPET_ID_RE


@pytest.mark.parametrize(
    "snippet_id",
    [
        "foo_bar",  # underscore — the canonical example from the originating finding
        "foo-",  # trailing dash
        "-foo",  # leading dash
        "foo--bar",  # double dash
        "FOO",  # uppercase
        "Foo-bar",  # mixed case
        "",  # empty
        "foo bar",  # whitespace
        "foo/bar",  # slash (bundle-ref-shape, not snippet-id-shape)
        "foo.bar",  # dot
    ],
)
def test_snippet_id_re_rejects_malformed(snippet_id: str) -> None:
    """Malformed snippet ids must be rejected by the canonical regex."""
    assert SNIPPET_ID_RE.match(snippet_id) is None


@pytest.mark.parametrize(
    "snippet_id",
    [
        "foo",
        "foo-bar",
        "foo-bar-baz",
        "abc123",
        "a1-b2-c3",
        "x",
        "0",
    ],
)
def test_snippet_id_re_accepts_kebab_case(snippet_id: str) -> None:
    """Well-formed kebab-case snippet ids must be accepted."""
    assert SNIPPET_ID_RE.match(snippet_id) is not None
