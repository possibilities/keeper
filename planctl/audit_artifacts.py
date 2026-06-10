"""Close-phase audit artifact subtree: paths, hash, commit-free atomic writer.

``/plan:close`` is a content-blind coordinator: every
pipeline artifact (audit brief, audit report, verdict, follow-up plan) persists
as a file under gitignored ``<primary_repo>/.planctl/state/audits/<epic_id>/``,
validated at emission by the submit verbs. This module owns that subtree —
the path helpers, the artifact schema version, the canonical commit-set hash,
and a commit-free atomic writer.

Why a private writer (NOT ``store.atomic_write_json``): the store's writer
records the path in the session touched-paths log, which the mutating-verb
auto-commit then sweeps into a ``chore(planctl): …`` commit. Audit artifacts
live under gitignored ``state/`` and must NEVER draw a commit — like ``claim``'s
worker brief, they are runtime-state-only. So :func:`write_artifact` clones
``brief.py:write_brief`` (mkstemp same-dir → fsync → ``os.replace`` → parent-dir
fsync → 0600) without any touched-paths bookkeeping.

Schema: :data:`AUDIT_SCHEMA_VERSION` is integer ``1``; changes within a version
are additive-only. A reader that sees an artifact ``schema_version`` greater
than it knows hard-fails (:class:`ArtifactSchemaTooNewError`) rather than
silently mis-parsing a future shape.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path

#: Audit-artifact schema version. Integer, starts at 1; additive-only within a
#: version. The :func:`compute_commit_set_hash` canonical input folds this in,
#: so a schema bump deliberately invalidates every previously-computed hash.
AUDIT_SCHEMA_VERSION = 1

#: Artifact basenames under ``audits/<epic_id>/``. The brief is the only
#: artifact this task writes; the submit verbs (later tasks) write the rest.
BRIEF_BASENAME = "brief.json"
REPORT_BASENAME = "report.md"
REPORT_META_BASENAME = "report.meta.json"
VERDICT_BASENAME = "verdict.json"
FOLLOWUP_BASENAME = "followup.yaml"


class ArtifactSchemaTooNewError(Exception):
    """An on-disk artifact carries a ``schema_version`` newer than this code.

    Carries the offending ``found`` version and the ``known`` ceiling so a
    reader verb can surface both in its error envelope. A reader hard-fails on
    too-new rather than guessing at a future shape.
    """

    def __init__(self, found: int, known: int = AUDIT_SCHEMA_VERSION) -> None:
        self.found = found
        self.known = known
        super().__init__(
            f"audit artifact schema_version {found} is newer than this "
            f"planctl knows ({known}); upgrade planctl"
        )


def audits_root(primary_repo: str | Path) -> Path:
    """Return ``<primary_repo>/.planctl/state/audits`` (not created here)."""
    return Path(primary_repo).resolve() / ".planctl" / "state" / "audits"


def audit_dir(primary_repo: str | Path, epic_id: str) -> Path:
    """Return the per-epic artifact dir, creating the tree lazily (0700).

    ``mkdir(parents=True, exist_ok=True)`` mints ``audits/`` and the per-epic
    subdir on first use; both are chmod'd to ``0700`` (owner-only) regardless of
    umask, matching the owner-only posture of the artifacts they hold. Idempotent
    — a re-call on an existing tree only re-asserts the mode.
    """
    root = audits_root(primary_repo)
    epic_dir = root / epic_id
    epic_dir.mkdir(parents=True, exist_ok=True)
    # Re-assert 0700 on both levels (mkdir honors umask on create).
    os.chmod(root, 0o700)
    os.chmod(epic_dir, 0o700)
    return epic_dir


def brief_path(primary_repo: str | Path, epic_id: str) -> Path:
    """Absolute path to ``audits/<epic_id>/brief.json`` (dir created lazily)."""
    return audit_dir(primary_repo, epic_id) / BRIEF_BASENAME


def report_path(primary_repo: str | Path, epic_id: str) -> Path:
    """Absolute path to ``audits/<epic_id>/report.md`` (dir created lazily)."""
    return audit_dir(primary_repo, epic_id) / REPORT_BASENAME


def report_meta_path(primary_repo: str | Path, epic_id: str) -> Path:
    """Absolute path to ``audits/<epic_id>/report.meta.json`` (dir created lazily)."""
    return audit_dir(primary_repo, epic_id) / REPORT_META_BASENAME


def verdict_path(primary_repo: str | Path, epic_id: str) -> Path:
    """Absolute path to ``audits/<epic_id>/verdict.json`` (dir created lazily)."""
    return audit_dir(primary_repo, epic_id) / VERDICT_BASENAME


def followup_path(primary_repo: str | Path, epic_id: str) -> Path:
    """Absolute path to ``audits/<epic_id>/followup.yaml`` (dir created lazily)."""
    return audit_dir(primary_repo, epic_id) / FOLLOWUP_BASENAME


def compute_commit_set_hash(commit_groups: list[dict]) -> str:
    """Canonical, order-independent SHA-256 over an epic's source commit set.

    The hash pins the exact set of source commits the close pipeline was run
    against, so ``close-finalize`` can refuse on a ``commit_set_hash`` mismatch
    (a commit landed after the audit). It MUST be deterministic and independent
    of the iteration order of ``commit_groups`` and of the SHA order within a
    repo group — only the *set* of (repo, sha) pairs matters.

    Canonicalization:

    - Per repo: SHAs are sorted lexicographically (a set has no order; sorting
      pins it). Duplicate SHAs within a group collapse.
    - Repos are keyed by absolute path and the ``{repo: [sorted-shas]}`` map is
      serialized with ``sort_keys=True`` (repo order is irrelevant to the set).
    - The artifact schema version is folded in, so a schema bump invalidates
      every prior hash by construction.
    - No timestamps, no first-seen order, no Python ``set`` is ever hashed
      (set iteration order is non-deterministic across runs).

    The input ``commit_groups`` (first-seen repo order, used for display) is
    NEVER mutated — sorting happens on copies.
    """
    by_repo: dict[str, list[str]] = {}
    for group in commit_groups:
        repo = str(group["repo"])
        shas = group.get("shas") or []
        # Dedup + lexicographic sort pins the per-repo SHA set deterministically.
        by_repo[repo] = sorted(set(shas))

    canonical = {
        "schema_version": AUDIT_SCHEMA_VERSION,
        "commit_set": by_repo,
    }
    payload = json.dumps(
        canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def write_artifact(path: str | Path, content: str) -> Path:
    """Atomically write *content* to *path* commit-free; return the resolved path.

    Cloned from ``brief.py:write_brief`` — same-directory ``mkstemp`` temp →
    fsync → ``os.replace`` → parent-dir fsync, then ``0600`` on the final path.
    Atomic (no partial read on a crash) and durable. The temp file is cleaned up
    on any write failure, so a render/serialize failure mid-write leaves no
    ``.tmp`` residue.

    Deliberately NOT ``store.atomic_write_json``: this writer records NOTHING in
    the session touched-paths log, so the next mutating verb's auto-commit never
    sweeps the artifact into a ``.planctl/`` commit. Audit artifacts are
    runtime-state-only.

    The parent directory is created (``parents=True``, 0700) if absent. The
    destination is a trusted local path under gitignored ``state/`` — no
    reader-side TOCTOU hardening is warranted.
    """
    dest = Path(path).resolve()
    parent = dest.parent
    parent.mkdir(parents=True, exist_ok=True)

    fd, tmp_path = tempfile.mkstemp(dir=str(parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, dest)
        # fsync the parent dir so the new directory entry is durable.
        parent_fd = os.open(str(parent), os.O_RDONLY)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
    except Exception:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise

    return dest


def write_brief_artifact(primary_repo: str | Path, epic_id: str, brief: dict) -> Path:
    """Serialize *brief* to ``audits/<epic_id>/brief.json`` (atomic, commit-free).

    Convenience wrapper: resolves the brief path (creating the per-epic dir at
    0700) and writes the JSON via :func:`write_artifact`. Stable serialization
    (``indent=2, sort_keys=True``) keeps the on-disk brief diff-friendly.
    """
    dest = brief_path(primary_repo, epic_id)
    content = json.dumps(brief, indent=2, sort_keys=True) + "\n"
    return write_artifact(dest, content)


__all__ = (
    "AUDIT_SCHEMA_VERSION",
    "BRIEF_BASENAME",
    "REPORT_BASENAME",
    "REPORT_META_BASENAME",
    "VERDICT_BASENAME",
    "FOLLOWUP_BASENAME",
    "ArtifactSchemaTooNewError",
    "audits_root",
    "audit_dir",
    "brief_path",
    "report_path",
    "report_meta_path",
    "verdict_path",
    "followup_path",
    "compute_commit_set_hash",
    "write_artifact",
    "write_brief_artifact",
)
