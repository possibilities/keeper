"""Repo-root inference primitives for planctl.

Two pure helpers + the generated-path exclusion list:

- ``find_repo_root(path)`` — walk up from *path* to the nearest ``.git``
  ancestor (longest-match / deepest-wins, so nested submodule roots beat
  the outer monorepo).
- ``is_generated(path)`` — predicate matching the
  ``GENERATED_PREFIXES`` / ``GENERATED_SUFFIXES`` allowlist below;
  pass absolute, resolved paths.

These primitives are used wherever planctl needs to attribute a file path
to its owning repo (e.g. ``jobctl find-task-commit`` traversal, ad-hoc
analysis tooling). Extend ``GENERATED_PREFIXES`` / ``GENERATED_SUFFIXES``
when new build tools introduce generated dirs that should be ignored.
"""

from __future__ import annotations

from pathlib import Path

# ---------------------------------------------------------------------------
# Exclusion list — generated / vendored paths. Maintained as module-level
# constants so future drift is easy to spot (one grep for this module).
# ---------------------------------------------------------------------------

GENERATED_PREFIXES: tuple[str, ...] = (
    "dist/",
    "build/",
    "node_modules/",
    "target/",
    ".venv/",
    "__pycache__/",
    ".git/",
)

GENERATED_SUFFIXES: tuple[str, ...] = (
    ".lock",
    ".pyc",
)


# ---------------------------------------------------------------------------
# Core helpers
# ---------------------------------------------------------------------------


def expand_path(path_str: str) -> str:
    """Expand ``~`` and resolve to an absolute path string.

    Single source of truth for the ``Path(s).expanduser().resolve()`` idiom
    used across planctl verbs (epic create, scaffold, refine-apply,
    set-target-repo). Callers handle the ``RuntimeError`` that
    ``expanduser()`` can raise on unresolvable ``~`` (no ``$HOME``, unknown
    user) — this helper deliberately does not swallow it so the caller can
    surface a typed failure (e.g. ``repo_invalid``).
    """
    return str(Path(path_str).expanduser().resolve())


def find_repo_root(path: Path) -> Path | None:
    """Walk up from *path* looking for a .git/ directory.

    Returns the repo root (the directory that contains .git/) using
    **longest-match** semantics: the deepest .git/ ancestor wins, so a
    nested git submodule's root beats the outer monorepo root. Walking
    leaf→root, the first match IS the deepest, so we return on the
    first hit.

    Returns None if no .git/ is found before the filesystem root.

    Note: this differs from planctl's find_project_root() which uses
    git rev-parse --show-toplevel (shortest-match on the current working
    directory). Callers that need submodule-aware attribution use this
    helper instead.
    """
    path = path.resolve()
    # Start from the file's parent if path is a file, otherwise from path itself.
    candidate = path if path.is_dir() else path.parent
    while True:
        if (candidate / ".git").exists():
            return candidate
        parent = candidate.parent
        if parent == candidate:
            return None
        candidate = parent


def is_generated(path: Path) -> bool:
    """Return True if *path* looks like a generated or vendored file.

    Expects an absolute, resolved path; pass ``Path(p).resolve()`` first.
    """
    assert path.is_absolute(), f"is_generated expected absolute, got {path!r}"
    path_str = str(path)
    # Normalise to forward slashes for prefix matching.
    path_str_fwd = path_str.replace("\\", "/")

    # Suffix check.
    for suffix in GENERATED_SUFFIXES:
        if path_str_fwd.endswith(suffix):
            return True

    # Infix check: generated dirs can appear anywhere in an absolute path.
    # e.g. "/repo/node_modules/lodash/index.js" contains "/node_modules/".
    return any(f"/{prefix}" in path_str_fwd for prefix in GENERATED_PREFIXES)
