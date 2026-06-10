"""Wire-contract tests pinning the fast-gate autouse stubs to the real binaries.

The fast bucket (``uv run pytest tests/``) closes its subprocess seam with an
autouse stub in ``conftest.py``:

* ``_mock_dirty_probe`` fakes the ``git status --porcelain
  --untracked-files=all -- .planctl/`` spawn in ``build_planctl_invocation`` by
  walking ``.planctl/`` on disk.

A stub that silently drifts from the real wire would let the whole fast suite
false-pass against a contract the production code no longer honours. This test
pins the stub's faked shape against the REAL binary, so a drift in the live
``git`` wire breaks CI here — never the mock silently.

The test is marked into the slow bucket (``@pytest.mark.wire`` skips it unless
``--run-slow``) and opts out of the matching autouse stub so the real spawn
fires (``real_git`` for the dirty probe).
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from .conftest import _disk_walk_planctl_paths

# These tests drive the real binaries; opt the module out of the autouse
# empty-discovery isolation so scaffold resolution runs normally.
pytestmark = pytest.mark.real_roots


@pytest.mark.wire
@pytest.mark.real_git
def test_dirty_probe_stub_matches_real_git_status(planctl_git_repo):
    """The disk-walk dirty-probe == real ``git status`` over freshly-written .planctl/.

    ``_disk_walk_planctl_paths`` (what ``_mock_dirty_probe`` installs) returns
    every on-disk ``.planctl/`` file as a repo-relative path. The real ``git
    status --porcelain --untracked-files=all -- .planctl/`` over a fresh repo
    (nothing committed) lists every NON-gitignored ``.planctl/`` file.
    ``build_planctl_invocation`` intersects either set with the session
    touched-paths log, so the stub is faithful as long as it is a SUPERSET of
    the real status output. We assert the real status output ⊆ the disk walk
    (the gitignored ``state/`` paths the disk walk adds never appear in the
    touched log, so the surplus is inert).
    """
    repo = Path(planctl_git_repo)

    # Write a fresh, uncommitted .planctl/ file so the dirty set is non-empty.
    probe = repo / ".planctl" / "epics" / "fn-99-wire-probe.json"
    probe.write_text("{}\n", encoding="utf-8")

    # Real git status of .planctl/ (the production probe argv verbatim).
    result = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=all", "--", ".planctl/"],
        cwd=str(repo),
        capture_output=True,
        text=True,
    )
    real_paths: set[str] = set()
    for line in result.stdout.splitlines():
        if len(line) < 4:
            continue
        rel = line[3:].strip()
        if " -> " in rel:
            rel = rel.split(" -> ", 1)[1]
        if rel:
            real_paths.add(rel)

    # The disk-walk stub's output (the exact function _mock_dirty_probe installs).
    walked = _disk_walk_planctl_paths(repo)

    # The freshly-written, non-gitignored probe file must appear in both.
    assert ".planctl/epics/fn-99-wire-probe.json" in real_paths
    assert ".planctl/epics/fn-99-wire-probe.json" in walked
    # Every real (non-gitignored) dirty path is covered by the disk walk — so a
    # touched ∩ dirty intersection over the stub never drops a real entry.
    assert real_paths <= walked
