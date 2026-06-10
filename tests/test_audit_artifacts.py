"""Tests for `planctl.audit_artifacts` — the close-phase artifact subtree.

The module owns the gitignored `audits/<epic_id>/` subtree: path helpers,
`AUDIT_SCHEMA_VERSION`, the canonical order-independent `compute_commit_set_hash`,
and a commit-free atomic writer cloned from `brief.py:write_brief`.

Coverage (per the task's Test notes):
- hash determinism + order-independence (same set, shuffled input → same hash)
- per-repo SHA-set canonicalization (dedup + sort) and schema-version fold-in
- input `commit_groups` never mutated
- writer atomicity: no `.tmp` residue on a write failure
- 0700 dir mode, 0600 file mode
- NO git commit lands after a write (runtime-state-only contract)
- too-new schema reader hard-fail error carries found/known
"""

from __future__ import annotations

import json
import os
import stat
import subprocess

import pytest
from planctl import audit_artifacts
from planctl.audit_artifacts import (
    AUDIT_SCHEMA_VERSION,
    ArtifactSchemaTooNewError,
    audit_dir,
    audits_root,
    brief_path,
    compute_commit_set_hash,
    followup_path,
    report_path,
    verdict_path,
    write_artifact,
    write_brief_artifact,
)

# ---------------------------------------------------------------------------
# compute_commit_set_hash — determinism + order-independence
# ---------------------------------------------------------------------------


class TestCommitSetHash:
    def test_deterministic_same_input(self):
        groups = [{"repo": "/a", "shas": ["c", "a", "b"]}]
        assert compute_commit_set_hash(groups) == compute_commit_set_hash(groups)

    def test_order_independent_across_groups_and_shas(self):
        """Shuffling repo order AND per-repo SHA order yields the same hash."""
        g1 = [
            {"repo": "/a", "shas": ["sha2", "sha1"]},
            {"repo": "/b", "shas": ["sha4", "sha3"]},
        ]
        g2 = [
            {"repo": "/b", "shas": ["sha3", "sha4"]},
            {"repo": "/a", "shas": ["sha1", "sha2"]},
        ]
        assert compute_commit_set_hash(g1) == compute_commit_set_hash(g2)

    def test_dedup_within_repo(self):
        """Duplicate SHAs in a group collapse — the set is what's hashed."""
        with_dup = [{"repo": "/a", "shas": ["x", "x", "y"]}]
        without = [{"repo": "/a", "shas": ["y", "x"]}]
        assert compute_commit_set_hash(with_dup) == compute_commit_set_hash(without)

    def test_distinct_sets_distinct_hashes(self):
        a = [{"repo": "/a", "shas": ["sha1"]}]
        b = [{"repo": "/a", "shas": ["sha2"]}]
        assert compute_commit_set_hash(a) != compute_commit_set_hash(b)

    def test_empty_groups_is_stable_hash(self):
        assert compute_commit_set_hash([]) == compute_commit_set_hash([])

    def test_repo_attribution_matters(self):
        """The same SHA under different repos is a different set."""
        a = [{"repo": "/a", "shas": ["sha1"]}]
        b = [{"repo": "/b", "shas": ["sha1"]}]
        assert compute_commit_set_hash(a) != compute_commit_set_hash(b)

    def test_schema_version_folded_in(self):
        """A schema bump invalidates the hash by construction."""
        groups = [{"repo": "/a", "shas": ["sha1"]}]
        baseline = compute_commit_set_hash(groups)
        original = audit_artifacts.AUDIT_SCHEMA_VERSION
        try:
            audit_artifacts.AUDIT_SCHEMA_VERSION = original + 1
            bumped = compute_commit_set_hash(groups)
        finally:
            audit_artifacts.AUDIT_SCHEMA_VERSION = original
        assert bumped != baseline

    def test_input_not_mutated(self):
        """First-seen display order + unsorted SHAs survive the hash call."""
        groups = [
            {"repo": "/b", "shas": ["sha2", "sha1"]},
            {"repo": "/a", "shas": ["sha9"]},
        ]
        before = json.dumps(groups)
        compute_commit_set_hash(groups)
        assert json.dumps(groups) == before

    def test_missing_shas_key_treated_as_empty(self):
        """A group without `shas` hashes as an empty SHA set, no KeyError."""
        a = [{"repo": "/a"}]
        b = [{"repo": "/a", "shas": []}]
        assert compute_commit_set_hash(a) == compute_commit_set_hash(b)


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------


class TestPaths:
    def test_audits_root_shape(self, tmp_path):
        root = audits_root(tmp_path)
        assert root == (tmp_path / ".planctl" / "state" / "audits").resolve()

    def test_audits_root_not_created(self, tmp_path):
        """audits_root is a pure path — it does NOT create the dir."""
        audits_root(tmp_path)
        assert not (tmp_path / ".planctl" / "state" / "audits").exists()

    def test_artifact_basenames(self, tmp_path):
        epic = "fn-1-demo"
        assert brief_path(tmp_path, epic).name == "brief.json"
        assert report_path(tmp_path, epic).name == "report.md"
        assert verdict_path(tmp_path, epic).name == "verdict.json"
        assert followup_path(tmp_path, epic).name == "followup.yaml"

    def test_audit_dir_created_lazily_at_0700(self, tmp_path):
        epic = "fn-1-demo"
        d = audit_dir(tmp_path, epic)
        assert d.is_dir()
        assert d == (tmp_path / ".planctl" / "state" / "audits" / epic).resolve()
        # 0700 on both the per-epic dir and its `audits/` parent.
        assert stat.S_IMODE(d.stat().st_mode) == 0o700
        assert stat.S_IMODE(d.parent.stat().st_mode) == 0o700

    def test_audit_dir_idempotent(self, tmp_path):
        epic = "fn-1-demo"
        d1 = audit_dir(tmp_path, epic)
        (d1 / "marker").write_text("x")
        d2 = audit_dir(tmp_path, epic)  # re-call must not wipe contents
        assert d1 == d2
        assert (d2 / "marker").read_text() == "x"


# ---------------------------------------------------------------------------
# Atomic writer — atomicity, modes, no temp residue
# ---------------------------------------------------------------------------


class TestWriteArtifact:
    def test_writes_content_and_returns_path(self, tmp_path):
        dest = tmp_path / "sub" / "a.txt"
        out = write_artifact(dest, "hello\n")
        assert out == dest.resolve()
        assert dest.read_text(encoding="utf-8") == "hello\n"

    def test_file_mode_is_0600(self, tmp_path):
        dest = tmp_path / "a.txt"
        write_artifact(dest, "x")
        assert stat.S_IMODE(dest.stat().st_mode) == 0o600

    def test_parent_created_when_absent(self, tmp_path):
        dest = tmp_path / "deep" / "nested" / "a.txt"
        write_artifact(dest, "x")
        assert dest.exists()

    def test_overwrite_is_atomic_replace(self, tmp_path):
        dest = tmp_path / "a.txt"
        write_artifact(dest, "v1")
        write_artifact(dest, "v2")
        assert dest.read_text() == "v2"

    def test_no_temp_residue_on_write_failure(self, tmp_path, monkeypatch):
        """A failure mid-write leaves NO `.tmp` file in the target dir."""
        dest = tmp_path / "a.txt"

        def _boom(*a, **k):
            raise OSError("disk full")

        # Force os.replace to blow up after the temp is written + fsynced.
        monkeypatch.setattr(audit_artifacts.os, "replace", _boom)
        with pytest.raises(OSError, match="disk full"):
            write_artifact(dest, "x")
        # No final file, and crucially no leaked .tmp residue.
        assert not dest.exists()
        assert list(tmp_path.glob("*.tmp")) == []

    def test_write_brief_artifact_round_trip(self, tmp_path):
        epic = "fn-1-demo"
        brief = {"schema_version": AUDIT_SCHEMA_VERSION, "epic_id": epic, "k": "v"}
        out = write_brief_artifact(tmp_path, epic, brief)
        assert out == brief_path(tmp_path, epic)
        loaded = json.loads(out.read_text(encoding="utf-8"))
        assert loaded == brief
        assert stat.S_IMODE(out.stat().st_mode) == 0o600


# ---------------------------------------------------------------------------
# Runtime-state-only contract: a write draws NO git commit.
# ---------------------------------------------------------------------------


@pytest.mark.real_git
class TestNoCommit:
    def _head(self, repo):
        return subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()

    def test_brief_write_lands_no_commit(self, planctl_git_repo):
        """Writing an audit brief must NOT advance HEAD nor leave a tracked diff.

        The writer bypasses the store's touched-paths log, so the next mutating
        verb's auto-commit can never sweep the artifact. We assert HEAD is
        unmoved and `git status --porcelain` shows nothing tracked.
        """
        repo = planctl_git_repo
        epic = "fn-1-demo"
        before = self._head(repo)
        write_brief_artifact(
            repo, epic, {"schema_version": AUDIT_SCHEMA_VERSION, "epic_id": epic}
        )
        after = self._head(repo)
        assert before == after
        # `state/` is gitignored, so the brief never shows in porcelain.
        porcelain = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=repo,
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        assert ".planctl/state/audits" not in porcelain


# ---------------------------------------------------------------------------
# Schema-version: present, integer; reader hard-fails too-new.
# ---------------------------------------------------------------------------


class TestSchemaVersion:
    def test_version_is_positive_int(self):
        assert isinstance(AUDIT_SCHEMA_VERSION, int)
        assert AUDIT_SCHEMA_VERSION >= 1

    def test_too_new_error_carries_found_and_known(self):
        err = ArtifactSchemaTooNewError(AUDIT_SCHEMA_VERSION + 1)
        assert err.found == AUDIT_SCHEMA_VERSION + 1
        assert err.known == AUDIT_SCHEMA_VERSION
        assert str(AUDIT_SCHEMA_VERSION + 1) in str(err)


def test_no_world_or_group_perms_on_dir_and_file(tmp_path):
    """Defense-in-depth: neither the artifact dir nor file grants group/other."""
    epic = "fn-1-demo"
    d = audit_dir(tmp_path, epic)
    f = write_artifact(brief_path(tmp_path, epic), "{}")
    assert not (d.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO))
    assert not (f.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO))
    assert os.path.exists(f)
