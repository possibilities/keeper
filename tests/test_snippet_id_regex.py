"""Pin `SNIPPET_ID_RE` shape — canonical source of the snippet-id constraint.

Task: fn-528-align-plan-phase-1a-snippet-id-regex.1

`/plan` Phase 1a (`apps/planctl/skills/plan/SKILL.md`) mirrors this regex
inline so a `--snippets foo_bar` invocation fails at the planner's front
door, not at Phase 5e via `planctl task set-snippets`.  If this regex
shape changes, update the SKILL.md per-snippet-id assertion in lockstep.
"""

from __future__ import annotations

import pytest
from planctl.bundle_ref import BUNDLE_REF_RE, SNIPPET_ID_RE


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


# ---------------------------------------------------------------------------
# BUNDLE_REF_RE shape — the two valid namespaces are ``bundle/`` and
# ``sketch/``.  Any other namespace prefix (including the legacy ``arc``
# namespace) is rejected outright; the rejection cases below guard
# against an accidental re-add.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "ref",
    [
        # The legacy "arc" namespace is not valid. Guards re-add.
        "arc/foo/bar",
        "arc/snippeting/main",
        "arc/foo/../etc",
        # Path-traversal / over-deep / case / empty-segment rejects.
        "bundle/foo/../etc",
        "bundle/a/b/c",
        "Bundle/Dev",
        "bundle/",
        "bundle/UPPER",
        "ftp/x",
        "/abs/path",
    ],
)
def test_bundle_ref_re_rejects(ref: str) -> None:
    """Retired "arc" namespace and malformed refs must be rejected."""
    assert BUNDLE_REF_RE.match(ref) is None


@pytest.mark.parametrize(
    "ref",
    [
        "bundle/dev-env",
        "bundle/snippeting-main",
        "bundle/foo/bar",
        "sketch/runtime-substrate",
        "sketch/draft-1",
    ],
)
def test_bundle_ref_re_accepts(ref: str) -> None:
    """Well-formed ``bundle/`` and ``sketch/`` refs must be accepted."""
    assert BUNDLE_REF_RE.match(ref) is not None
