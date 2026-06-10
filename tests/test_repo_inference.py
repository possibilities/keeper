"""Unit tests for apps/planctl/planctl/repo_inference.py.

Tests cover the repo-inference primitives:

- ``find_repo_root``: longest-match deepest-``.git`` semantic, subdir case,
  no-git-anywhere case
- ``is_generated``: suffix + infix matching, absolute-path assert
"""

from __future__ import annotations

from pathlib import Path

import pytest
from planctl.repo_inference import find_repo_root, is_generated

# ---------------------------------------------------------------------------
# Fixtures — synthetic repo trees using tmp_path
# ---------------------------------------------------------------------------


@pytest.fixture()
def repo_a(tmp_path: Path) -> Path:
    """A minimal git repo at tmp_path/repo_a."""
    root = tmp_path / "repo_a"
    (root / ".git").mkdir(parents=True)
    (root / "src").mkdir()
    return root


def _make_files(repo: Path, subdir: str, names: list[str]) -> list[Path]:
    """Create empty files under repo/subdir and return their Paths."""
    d = repo / subdir
    d.mkdir(parents=True, exist_ok=True)
    paths = []
    for name in names:
        p = d / name
        p.touch()
        paths.append(p)
    return paths


# ---------------------------------------------------------------------------
# find_repo_root
# ---------------------------------------------------------------------------


class TestFindRepoRoot:
    def test_returns_repo_root_for_file_inside_repo(self, repo_a: Path) -> None:
        f = _make_files(repo_a, "src", ["main.py"])[0]
        assert find_repo_root(f) == repo_a

    def test_returns_repo_root_for_nested_file(self, repo_a: Path) -> None:
        f = _make_files(repo_a, "src/deep/nested", ["util.py"])[0]
        assert find_repo_root(f) == repo_a

    def test_returns_none_outside_any_repo(self, tmp_path: Path) -> None:
        # tmp_path itself has no .git/
        no_repo = tmp_path / "orphan"
        no_repo.mkdir()
        f = no_repo / "file.py"
        f.touch()
        assert find_repo_root(f) is None

    def test_returns_repo_root_for_directory_path(self, repo_a: Path) -> None:
        subdir = repo_a / "src"
        assert find_repo_root(subdir) == repo_a

    def test_nested_submodule_wins_over_outer_repo(self, tmp_path: Path) -> None:
        """Longest-match: nested .git/ beats outer .git/."""
        outer = tmp_path / "outer"
        (outer / ".git").mkdir(parents=True)
        inner = outer / "sub" / "inner"
        (inner / ".git").mkdir(parents=True)
        f = inner / "file.py"
        f.touch()
        # find_repo_root walks up and returns FIRST .git/ found (deepest = inner)
        assert find_repo_root(f) == inner


# ---------------------------------------------------------------------------
# is_generated
# ---------------------------------------------------------------------------


class TestIsGenerated:
    @pytest.mark.parametrize(
        "path_str",
        [
            "/project/dist/bundle.js",
            "/project/build/output.o",
            "/project/node_modules/lodash/index.js",
            "/project/target/debug/app",
            "/project/.venv/lib/python.py",
            "/project/__pycache__/mod.cpython-312.pyc",
            "/project/.git/config",
            "/project/requirements.lock",
            "/project/poetry.lock",
            "/project/app.pyc",
        ],
    )
    def test_generated_paths_return_true(self, path_str: str) -> None:
        assert is_generated(Path(path_str)) is True

    @pytest.mark.parametrize(
        "path_str",
        [
            "/project/src/main.py",
            "/project/apps/planctl/repo_inference.py",
            "/project/apps/planctl/cli.py",
            "/project/tests/test_foo.py",
            "/project/README.md",
            "/project/pyproject.toml",
        ],
    )
    def test_non_generated_paths_return_false(self, path_str: str) -> None:
        assert is_generated(Path(path_str)) is False

    def test_dist_as_infix_is_generated(self) -> None:
        # dist/ appearing mid-path (not just prefix)
        assert is_generated(Path("/repo/packages/foo/dist/index.js")) is True

    def test_node_modules_as_infix_is_generated(self) -> None:
        assert is_generated(Path("/repo/apps/web/node_modules/react/index.js")) is True

    def test_relative_path_fails_assertion(self) -> None:
        """is_generated requires absolute paths; relative paths trip the assert."""
        with pytest.raises(AssertionError):
            is_generated(Path("relative/path.py"))
