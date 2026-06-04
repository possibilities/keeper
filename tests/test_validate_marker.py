"""Tests for validate --epic marker-write behavior (last_validated_at) and
re-stamp-on-mutation behavior (VALIDATION_RESTAMP_VERBS).

Mutating verbs resolve the session id from CLAUDE_CODE_SESSION_ID; these
tests set it explicitly.

fn-587 task .4: the 14 structural verbs in VALIDATION_RESTAMP_VERBS now
RE-STAMP ``last_validated_at`` to a fresh ``now_iso()`` value on success
(strict timestamp newer-than the pre-mutation stamp) instead of clearing it
to ``None``.  ``epic invalidate`` is the ONLY surviving null path.

Cases:
- validate --epic <id> on never-validated, structurally valid epic:
  marker set, NDJSON invocation line emitted, epic JSON updated.
- validate --epic <id> on already-validated epic:
  no NDJSON line, no marker change (idempotent).
- validate --epic <id> on structurally invalid epic:
  exit 1, no marker write, no NDJSON line.
- validate (no --epic):
  walks all epics, emits report-only envelope, never writes markers.
- Coverage test: every verb in VALIDATION_RESTAMP_VERBS re-stamps the marker
  with a strictly-newer timestamp.
- Negative test: a no-restamp verb (done) does not touch the marker.
"""

from __future__ import annotations

import json
import os
import subprocess

from click.testing import CliRunner  # type: ignore[import-untyped]
from planctl.cli import cli
from planctl.validation_restamp import VALIDATION_RESTAMP_VERBS

from .conftest import run_cli


def _parse_json_stream(text: str) -> list[dict]:
    """Extract all JSON objects from a string that may contain pretty-printed
    or compact JSON documents concatenated together (NDJSON or multi-line JSON)."""
    decoder = json.JSONDecoder()
    docs = []
    idx = 0
    while idx < len(text):
        # Skip whitespace between documents.
        while idx < len(text) and text[idx] in " \t\n\r":
            idx += 1
        if idx >= len(text):
            break
        obj, end = decoder.raw_decode(text, idx)
        docs.append(obj)
        idx = end
    return docs


def _create_project(tmp_path, monkeypatch):
    """Init a planctl project in tmp_path and return the path."""
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-validate-marker-fixture")
    monkeypatch.chdir(tmp_path)
    # git init so the `claim` verb's `promptctl render-spec` shell-out resolves
    # its project root (.git walk) to this project, not a parent repo. Epics
    # here null out primary_repo, so claim falls back to this git root.
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    runner = CliRunner()
    result = runner.invoke(cli, ["init"])
    assert result.exit_code == 0, result.output
    return tmp_path


def _create_epic(project_path) -> str:
    """Create a structurally valid epic and return its ID.

    Nulls out primary_repo and touched_repos after creation because the test
    project directory is not a git repo (no .git/), so validate would reject
    the paths as invalid.  Legacy null-field epics skip multi-repo validation.
    """
    runner = CliRunner()
    env = {**os.environ, "CLAUDE_CODE_SESSION_ID": "test-validate-marker-fixture"}
    result = runner.invoke(
        cli,
        ["epic", "create", "--title", "Validate marker test epic"],
        env=env,
    )
    assert result.exit_code == 0, result.output
    epic_id = json.loads(result.output.strip())["epic"]["id"]

    # Null out multi-repo fields so validate treats this as a legacy epic.
    epic_path = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    data = json.loads(epic_path.read_text())
    data["primary_repo"] = None
    data["touched_repos"] = None
    epic_path.write_text(json.dumps(data))

    return epic_id


def _read_epic_json(project_path, epic_id) -> dict:
    epic_path = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    return json.loads(epic_path.read_text())


def _run_validate(project_path, extra_args=()):
    env = {**os.environ, "CLAUDE_CODE_SESSION_ID": "test-validate-marker-fixture"}
    return run_cli(["validate", *extra_args], cwd=str(project_path), env=env)


def test_validate_epic_stamps_marker_on_first_run(tmp_path, monkeypatch):
    """validate --epic <id> on a never-validated, valid epic writes last_validated_at
    and emits a planctl_invocation NDJSON line on stdout."""
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)

    # Pre-condition: marker is None.
    epic_before = _read_epic_json(project_path, epic_id)
    assert epic_before.get("last_validated_at") is None, (
        f"Expected last_validated_at=None before first validate, got: "
        f"{epic_before.get('last_validated_at')}"
    )

    result = _run_validate(project_path, ("--epic", epic_id))
    assert result.returncode == 0, f"validate exited non-zero:\n{result.stderr}"

    # Parse all JSON objects from stdout stream.
    docs = _parse_json_stream(result.stdout)
    assert len(docs) == 2, (
        f"Expected 2 JSON documents (envelope + invocation), got {len(docs)}:\n"
        f"{result.stdout!r}"
    )

    doc1 = docs[0]
    assert doc1.get("valid") is True, f"Expected valid=True in doc1: {doc1}"

    doc2 = docs[1]
    assert "planctl_invocation" in doc2, f"Expected planctl_invocation in doc2: {doc2}"
    inv = doc2["planctl_invocation"]
    assert inv.get("op") == "validate", f"Expected op=validate: {inv}"
    assert inv.get("target") == epic_id, f"Expected target={epic_id}: {inv}"

    # Epic JSON updated.
    epic_after = _read_epic_json(project_path, epic_id)
    assert epic_after.get("last_validated_at") is not None, (
        "last_validated_at should be set after first validate"
    )


def test_validate_epic_idempotent_on_already_stamped(tmp_path, monkeypatch):
    """validate --epic <id> on an already-stamped epic is a no-op:
    no second NDJSON document, marker unchanged."""
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)

    # First validate: stamps the marker.
    result1 = _run_validate(project_path, ("--epic", epic_id))
    assert result1.returncode == 0
    docs1 = _parse_json_stream(result1.stdout)
    assert len(docs1) == 2, (
        f"First validate should emit 2 JSON docs: {result1.stdout!r}"
    )

    epic_after_first = _read_epic_json(project_path, epic_id)
    ts_first = epic_after_first["last_validated_at"]

    # Second validate: already-stamped, should be idempotent.
    result2 = _run_validate(project_path, ("--epic", epic_id))
    assert result2.returncode == 0, f"Re-validate exited non-zero:\n{result2.stderr}"

    docs2 = _parse_json_stream(result2.stdout)
    assert len(docs2) == 1, (
        f"Re-validate of already-stamped epic should emit 1 JSON doc (no invocation), "
        f"got {len(docs2)}: {result2.stdout!r}"
    )
    assert docs2[0].get("valid") is True

    # Marker unchanged.
    epic_after_second = _read_epic_json(project_path, epic_id)
    assert epic_after_second["last_validated_at"] == ts_first, (
        "last_validated_at should not change on re-validate"
    )


def test_validate_epic_invalid_no_marker_no_invocation(tmp_path, monkeypatch):
    """validate --epic <id> on a structurally invalid epic:
    exits 1, no marker write, no planctl_invocation document."""
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)

    # Corrupt the epic JSON to make it invalid.
    epic_path = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    epic_data = json.loads(epic_path.read_text())
    del epic_data["title"]  # Remove required field.
    epic_path.write_text(json.dumps(epic_data))

    result = _run_validate(project_path, ("--epic", epic_id))
    assert result.returncode == 1, (
        f"Expected exit 1 on invalid epic, got {result.returncode}"
    )

    docs = _parse_json_stream(result.stdout)
    assert len(docs) == 1, (
        f"Invalid validate should emit only 1 JSON doc (no invocation), "
        f"got {len(docs)}: {result.stdout!r}"
    )
    assert docs[0].get("valid") is False

    # No invocation doc emitted.
    for doc in docs:
        assert "planctl_invocation" not in doc, (
            f"Invalid validate must not emit planctl_invocation: {doc}"
        )

    # Marker not written: the epic file was corrupted before the run, so
    # last_validated_at was never set. Verify by reading the current file
    # (which still has title removed — it was not restored by the failed run).
    current_data = json.loads(epic_path.read_text())
    assert current_data.get("last_validated_at") is None, (
        "last_validated_at must not be written on failed validate"
    )


def test_validate_all_never_writes_markers(tmp_path, monkeypatch):
    """validate (no --epic) walks all epics but never writes last_validated_at markers."""
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)

    # Pre-condition: marker is None.
    epic_before = _read_epic_json(project_path, epic_id)
    assert epic_before.get("last_validated_at") is None

    # Run validate without --epic.
    result = _run_validate(project_path)
    # May pass or fail depending on project state; what matters is no marker write.

    epic_after = _read_epic_json(project_path, epic_id)
    assert epic_after.get("last_validated_at") is None, (
        "validate-all must never write last_validated_at markers"
    )

    # Also confirm stdout has no planctl_invocation document.
    docs = _parse_json_stream(result.stdout)
    for doc in docs:
        assert "planctl_invocation" not in doc, (
            f"validate-all must not emit planctl_invocation: {doc}"
        )


# ---------------------------------------------------------------------------
# Coverage tests: every VALIDATION_RESTAMP_VERBS verb re-stamps
# last_validated_at to a strictly-newer timestamp
# ---------------------------------------------------------------------------

_ENV = {**os.environ, "CLAUDE_CODE_SESSION_ID": "test-validate-marker-fixture"}


def _run_planctl(args: list[str], cwd: str, input_text: str | None = None):
    return run_cli(args, cwd=cwd, env=_ENV, input_text=input_text)


# Canonical pre-stamp seed value used by every coverage test below.  Chosen
# to be very early so the post-write microsecond-precision now_iso() is
# guaranteed strictly greater.
_PRE_STAMP = "2020-01-01T00:00:00Z"


def _stamp_marker(project_path, epic_id: str, ts: str = _PRE_STAMP) -> None:
    """Directly write a non-None last_validated_at into the epic JSON."""
    import json as _json

    epic_path = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    data = _json.loads(epic_path.read_text())
    data["last_validated_at"] = ts
    epic_path.write_text(_json.dumps(data))


def _assert_marker_restamped(
    project_path, epic_id: str, verb: str, pre_stamp: str
) -> None:
    """Assert the verb left ``last_validated_at`` strictly NEWER than pre_stamp.

    fn-587 task .4: the 14 ``VALIDATION_RESTAMP_VERBS`` re-stamp the marker
    to ``now_iso()`` on success instead of clearing to None.  ``now_iso()``
    is microsecond-precision (fn-587 task .1) so the post-write stamp is
    guaranteed strictly greater than any reasonable pre-write seed.
    """
    epic_data = _read_epic_json(project_path, epic_id)
    new_stamp = epic_data.get("last_validated_at")
    assert isinstance(new_stamp, str) and new_stamp, (
        f"Verb '{verb}' did not re-stamp last_validated_at: got {new_stamp!r}"
    )
    assert new_stamp > pre_stamp, (
        f"Verb '{verb}' did not produce a strictly-newer last_validated_at: "
        f"pre={pre_stamp!r} post={new_stamp!r}"
    )


def _setup_epic_and_task(tmp_path, monkeypatch):
    """Init a project, scaffold an epic + task, return (project_path, epic_id, task_id).

    fn-565: minted via `scaffold` (the incremental `task create` verb is gone).
    The epic's multi-repo fields are nulled afterward so `validate` treats it as
    a legacy epic (the tmp dir is not a git repo), matching `_create_epic`.
    """
    from .conftest import seed_epic

    project_path = _create_project(tmp_path, monkeypatch)
    epic_id, task_ids = seed_epic(
        project_path, title="Validate marker test epic", n_tasks=1, env=_ENV
    )
    epic_path = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    data = json.loads(epic_path.read_text())
    data["primary_repo"] = None
    data["touched_repos"] = None
    epic_path.write_text(json.dumps(data))
    return project_path, epic_id, task_ids[0]


def test_restamp_on_refine_apply_adds_task(tmp_path, monkeypatch):
    """refine-apply add_tasks (new task on an existing epic) re-stamps the marker.

    fn-565: this replaces the removed `task-create` / `set-spec` marker-clear
    coverage — adding a task and rewriting its spec both ride refine-apply now,
    which IS in VALIDATION_RESTAMP_VERBS.
    """
    from .conftest import add_task

    project_path, epic_id, _task_id = _setup_epic_and_task(tmp_path, monkeypatch)
    _stamp_marker(project_path, epic_id)

    add_task(project_path, epic_id, title="New task", env=_ENV)
    _assert_marker_restamped(
        project_path, epic_id, "refine-apply (add_tasks)", _PRE_STAMP
    )


def test_restamp_on_set_description(tmp_path, monkeypatch):
    """set-description re-stamps last_validated_at."""
    project_path, epic_id, task_id = _setup_epic_and_task(tmp_path, monkeypatch)
    _stamp_marker(project_path, epic_id)

    desc_file = tmp_path / "desc.md"
    desc_file.write_text("Updated description text.\n")
    result = _run_planctl(
        ["task", "set-description", "--file", str(desc_file), task_id],
        cwd=str(project_path),
    )
    assert result.returncode == 0, (
        f"set-description failed: {result.stdout}\n{result.stderr}"
    )
    _assert_marker_restamped(project_path, epic_id, "set-description", _PRE_STAMP)


def test_restamp_on_set_acceptance(tmp_path, monkeypatch):
    """set-acceptance re-stamps last_validated_at."""
    project_path, epic_id, task_id = _setup_epic_and_task(tmp_path, monkeypatch)
    _stamp_marker(project_path, epic_id)

    acc_file = tmp_path / "acc.md"
    acc_file.write_text("- [ ] Updated acceptance\n")
    result = _run_planctl(
        ["task", "set-acceptance", "--file", str(acc_file), task_id],
        cwd=str(project_path),
    )
    assert result.returncode == 0, (
        f"set-acceptance failed: {result.stdout}\n{result.stderr}"
    )
    _assert_marker_restamped(project_path, epic_id, "set-acceptance", _PRE_STAMP)


def test_restamp_on_refine_apply_rewires_deps(tmp_path, monkeypatch):
    """refine-apply rewire_deps (full dep-list replace) re-stamps the marker.

    fn-565: replaces the removed `set-deps` marker-clear coverage — dep rewrites
    on an existing epic ride refine-apply now.
    """
    project_path, epic_id, task_id = _setup_epic_and_task(tmp_path, monkeypatch)
    _stamp_marker(project_path, epic_id)

    delta = tmp_path / "rewire_delta.yaml"
    delta.write_text(f"rewire_deps:\n  - task_id: {task_id}\n    deps: []\n")
    result = _run_planctl(
        ["refine-apply", epic_id, "--file", str(delta)],
        cwd=str(project_path),
    )
    assert result.returncode == 0, (
        f"refine-apply rewire failed: {result.stdout}\n{result.stderr}"
    )
    _assert_marker_restamped(
        project_path, epic_id, "refine-apply (rewire_deps)", _PRE_STAMP
    )


def test_restamp_on_reset(tmp_path, monkeypatch):
    """reset re-stamps last_validated_at."""
    project_path, epic_id, task_id = _setup_epic_and_task(tmp_path, monkeypatch)
    _stamp_marker(project_path, epic_id)

    result = _run_planctl(
        ["task", "reset", task_id],
        cwd=str(project_path),
    )
    assert result.returncode == 0, f"reset failed: {result.stdout}\n{result.stderr}"
    _assert_marker_restamped(project_path, epic_id, "reset", _PRE_STAMP)


def test_restamp_on_epic_add_dep(tmp_path, monkeypatch):
    """add-dep (epic-level) re-stamps last_validated_at."""
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)

    # Create a second epic to depend on.
    result2 = _run_planctl(
        ["epic", "create", "--title", "Dep epic"],
        cwd=str(project_path),
    )
    assert result2.returncode == 0, (
        f"epic create 2 failed: {result2.stdout}\n{result2.stderr}"
    )
    dep_epic_id = json.loads(result2.stdout.strip())["epic"]["id"]

    _stamp_marker(project_path, epic_id)

    result = _run_planctl(
        ["epic", "add-dep", epic_id, dep_epic_id],
        cwd=str(project_path),
    )
    assert result.returncode == 0, (
        f"epic add-dep failed: {result.stdout}\n{result.stderr}"
    )
    _assert_marker_restamped(project_path, epic_id, "add-dep", _PRE_STAMP)


def test_restamp_on_epic_add_deps(tmp_path, monkeypatch):
    """add-deps (batch epic-level) re-stamps last_validated_at."""
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)

    # Create a second epic to depend on.
    result2 = _run_planctl(
        ["epic", "create", "--title", "Dep epic"],
        cwd=str(project_path),
    )
    assert result2.returncode == 0, (
        f"epic create 2 failed: {result2.stdout}\n{result2.stderr}"
    )
    dep_epic_id = json.loads(result2.stdout.strip())["epic"]["id"]

    _stamp_marker(project_path, epic_id)

    result = _run_planctl(
        ["epic", "add-deps", epic_id, dep_epic_id],
        cwd=str(project_path),
    )
    assert result.returncode == 0, (
        f"epic add-deps failed: {result.stdout}\n{result.stderr}"
    )
    _assert_marker_restamped(project_path, epic_id, "add-deps", _PRE_STAMP)


def test_restamp_on_epic_rm_dep(tmp_path, monkeypatch):
    """rm-dep (epic-level) re-stamps last_validated_at."""
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)

    # Create a dep epic and add it first.
    result2 = _run_planctl(
        ["epic", "create", "--title", "Dep epic"],
        cwd=str(project_path),
    )
    assert result2.returncode == 0, (
        f"epic create 2 failed: {result2.stdout}\n{result2.stderr}"
    )
    dep_epic_id = json.loads(result2.stdout.strip())["epic"]["id"]

    _run_planctl(["epic", "add-dep", epic_id, dep_epic_id], cwd=str(project_path))
    _stamp_marker(project_path, epic_id)

    result = _run_planctl(
        ["epic", "rm-dep", epic_id, dep_epic_id],
        cwd=str(project_path),
    )
    assert result.returncode == 0, (
        f"epic rm-dep failed: {result.stdout}\n{result.stderr}"
    )
    _assert_marker_restamped(project_path, epic_id, "rm-dep", _PRE_STAMP)


def test_restamp_on_refine_apply(tmp_path, monkeypatch):
    """refine-apply (epic-spec rewrite on an existing epic) re-stamps last_validated_at."""
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)
    _stamp_marker(project_path, epic_id)

    delta = tmp_path / "delta.yaml"
    delta.write_text(
        "epic:\n  spec: |\n    ## Overview\n    Rewritten via refine-apply.\n"
    )
    result = _run_planctl(
        ["refine-apply", epic_id, "--file", str(delta)],
        cwd=str(project_path),
    )
    assert result.returncode == 0, (
        f"refine-apply failed: {result.stdout}\n{result.stderr}"
    )
    _assert_marker_restamped(project_path, epic_id, "refine-apply", _PRE_STAMP)


def test_all_restamp_verbs_covered():
    """Verify VALIDATION_RESTAMP_VERBS matches the verbs this test suite covers."""
    expected = {
        "set-description",
        "set-acceptance",
        "reset",
        "add-dep",
        # Batch epic-dep wirer added in fn-565.
        "add-deps",
        "rm-dep",
        # fn-565 removed the incremental verbs (task-create / set-spec /
        # set-deps / dep-add / set-plan) — their structural-restamp coverage now
        # rides scaffold (mint; NOT in the tuple) and refine-apply (rewrite; IS
        # in the tuple, listed below).
        # Multi-repo structural verbs added in fn-364.
        "set-primary-repo",
        "set-touched-repos",
        "set-target-repo",
        # Spec-metadata setters added in fn-513 (shared name across
        # task + epic surfaces).
        "set-snippets",
        "set-bundles",
        # Whole-tree refine delta added in fn-565 (rewrites an existing tree).
        "refine-apply",
    }
    assert set(VALIDATION_RESTAMP_VERBS) == expected, (
        f"VALIDATION_RESTAMP_VERBS has unexpected contents:\n"
        f"  got:      {sorted(VALIDATION_RESTAMP_VERBS)}\n"
        f"  expected: {sorted(expected)}"
    )


# ---------------------------------------------------------------------------
# Negative test: no-restamp verb (done) does not touch last_validated_at
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# set-*-repo verb tests: require a real git repo in tmp_path
# ---------------------------------------------------------------------------


def _init_git_repo(path) -> None:
    """Run git init in path so _validate_repo_path accepts it."""
    result = subprocess.run(
        ["git", "init"],
        cwd=str(path),
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"git init failed: {result.stderr}"


def _create_epic_with_primary_repo(project_path, repo_path: str) -> str:
    """Create an epic and set primary_repo to a real git repo path.

    Unlike _create_epic(), this does NOT null out the multi-repo fields —
    the set-*-repo verbs validate that primary_repo points at a real .git/ dir.
    """
    runner = CliRunner()
    env = {**os.environ, "CLAUDE_CODE_SESSION_ID": "test-validate-marker-fixture"}
    result = runner.invoke(
        cli,
        ["epic", "create", "--title", "Validate marker repo test epic"],
        env=env,
    )
    assert result.exit_code == 0, result.output
    epic_id = json.loads(result.output.strip())["epic"]["id"]

    # Write primary_repo directly so validate does not reject the path.
    epic_path = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    data = json.loads(epic_path.read_text())
    data["primary_repo"] = repo_path
    data["touched_repos"] = [repo_path]
    epic_path.write_text(json.dumps(data))

    return epic_id


def test_restamp_on_set_primary_repo(tmp_path, monkeypatch):
    """epic set-primary-repo re-stamps last_validated_at.

    fn-587 task .4: the post-write integrity check requires
    ``primary_repo == data_dir.parent`` (samefile), so the epic's primary_repo
    is pinned to the project_path (which IS the git repo via _create_project's
    git init).  Earlier coverage cleared the marker without an integrity check;
    the new contract re-validates the post-mutation tree before re-stamping.
    """
    project_path = _create_project(tmp_path, monkeypatch)

    # project_path is the git repo (init'd by _create_project); the samefile
    # rule on primary_repo means we MUST pin it to the same path.
    epic_id = _create_epic_with_primary_repo(project_path, str(project_path))
    _stamp_marker(project_path, epic_id)

    result = _run_planctl(
        ["epic", "set-primary-repo", epic_id, "--path", str(project_path)],
        cwd=str(project_path),
    )
    assert result.returncode == 0, (
        f"epic set-primary-repo failed: {result.stdout}\n{result.stderr}"
    )
    _assert_marker_restamped(project_path, epic_id, "set-primary-repo", _PRE_STAMP)


def test_restamp_on_set_touched_repos(tmp_path, monkeypatch):
    """epic set-touched-repos re-stamps last_validated_at."""
    project_path = _create_project(tmp_path, monkeypatch)

    # primary_repo MUST be the project path (samefile rule).  touched_repos
    # gets the same path so the integrity check passes; the verb's own
    # _validate_repo_path accepts any path that has a .git/ dir, which
    # project_path does (via _create_project's git init).
    epic_id = _create_epic_with_primary_repo(project_path, str(project_path))
    _stamp_marker(project_path, epic_id)

    result = _run_planctl(
        ["epic", "set-touched-repos", epic_id, "--paths", str(project_path)],
        cwd=str(project_path),
    )
    assert result.returncode == 0, (
        f"epic set-touched-repos failed: {result.stdout}\n{result.stderr}"
    )
    _assert_marker_restamped(project_path, epic_id, "set-touched-repos", _PRE_STAMP)


def test_restamp_on_set_target_repo(tmp_path, monkeypatch):
    """task set-target-repo re-stamps last_validated_at on the PARENT EPIC."""
    from .conftest import seed_epic

    project_path = _create_project(tmp_path, monkeypatch)

    # fn-565: mint epic + child task via scaffold (the incremental `task create`
    # verb is gone), then patch primary_repo onto the epic so set-target-repo's
    # repo validation has a real .git/ dir to resolve against.  primary_repo
    # MUST be the project path (samefile rule in the post-write integrity check).
    epic_id, task_ids = seed_epic(
        project_path, title="Validate marker repo test epic", n_tasks=1, env=_ENV
    )
    task_id = task_ids[0]
    epic_path = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    data = json.loads(epic_path.read_text())
    data["primary_repo"] = str(project_path)
    data["touched_repos"] = [str(project_path)]
    epic_path.write_text(json.dumps(data))

    _stamp_marker(project_path, epic_id)

    result = _run_planctl(
        ["task", "set-target-repo", task_id, "--path", str(project_path)],
        cwd=str(project_path),
    )
    assert result.returncode == 0, (
        f"task set-target-repo failed: {result.stdout}\n{result.stderr}"
    )
    # The marker lives on the parent epic, not the task.
    _assert_marker_restamped(project_path, epic_id, "set-target-repo", _PRE_STAMP)


# ---------------------------------------------------------------------------
# set-target-repo recomputes epic.touched_repos from the union of all tasks'
# target_repo values (fn-585: auto-roll invariant).
# ---------------------------------------------------------------------------


def _seed_multi_task_epic_with_repos(
    project_path, _repo_a_path: str, task_repos: list[str]
) -> tuple[str, list[str]]:
    """Scaffold an epic with N tasks, pin primary_repo to ``project_path``, and
    write per-task ``target_repo`` values directly into each task JSON.

    fn-587 task .4: ``primary_repo`` MUST be the project path (samefile rule in
    the post-write integrity check).  The legacy ``repo_a_path`` parameter is
    retained for call-site compatibility but ignored — it was previously used
    as both ``primary_repo`` and a target-repo seed; the rollup invariant only
    cares about the ``task_repos`` list.

    Returns ``(epic_id, task_ids)``.  Each task_repos[i] is written to
    task_ids[i]'s ``target_repo`` so the union seed reflects ``task_repos``.
    """
    from .conftest import seed_epic

    epic_id, task_ids = seed_epic(
        project_path,
        title="Touched-repos rollup test epic",
        n_tasks=len(task_repos),
        env=_ENV,
    )
    epic_path = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    data = json.loads(epic_path.read_text())
    data["primary_repo"] = str(project_path)
    data["touched_repos"] = sorted(set(task_repos))
    epic_path.write_text(json.dumps(data))
    for task_id, tr in zip(task_ids, task_repos, strict=True):
        task_path = project_path / ".planctl" / "tasks" / f"{task_id}.json"
        tdata = json.loads(task_path.read_text())
        tdata["target_repo"] = tr
        task_path.write_text(json.dumps(tdata))
    return epic_id, task_ids


def test_set_target_repo_recomputes_touched_repos_grow(tmp_path, monkeypatch):
    """3 tasks all targeting repo A; set-target-repo task[1] -> repo B;
    epic.touched_repos == sorted([A, B])."""
    project_path = _create_project(tmp_path, monkeypatch)

    repo_a = tmp_path / "repo-a"
    repo_a.mkdir()
    _init_git_repo(repo_a)
    repo_b = tmp_path / "repo-b"
    repo_b.mkdir()
    _init_git_repo(repo_b)

    epic_id, task_ids = _seed_multi_task_epic_with_repos(
        project_path, str(repo_a), [str(repo_a), str(repo_a), str(repo_a)]
    )

    result = _run_planctl(
        ["task", "set-target-repo", task_ids[1], "--path", str(repo_b)],
        cwd=str(project_path),
    )
    assert result.returncode == 0, (
        f"set-target-repo failed: {result.stdout}\n{result.stderr}"
    )

    epic_data = _read_epic_json(project_path, epic_id)
    assert epic_data["touched_repos"] == sorted([str(repo_a), str(repo_b)]), (
        f"touched_repos grow mismatch: {epic_data['touched_repos']}"
    )


def test_set_target_repo_recomputes_touched_repos_shrink(tmp_path, monkeypatch):
    """task 1 -> A, task 2 -> B; set-target-repo task[1] -> A;
    epic.touched_repos == [A] (B drops since no task targets it)."""
    project_path = _create_project(tmp_path, monkeypatch)

    repo_a = tmp_path / "repo-a"
    repo_a.mkdir()
    _init_git_repo(repo_a)
    repo_b = tmp_path / "repo-b"
    repo_b.mkdir()
    _init_git_repo(repo_b)

    epic_id, task_ids = _seed_multi_task_epic_with_repos(
        project_path, str(repo_a), [str(repo_a), str(repo_b)]
    )

    # Re-target task[1] (currently B) back to A; B should drop out of touched_repos.
    result = _run_planctl(
        ["task", "set-target-repo", task_ids[1], "--path", str(repo_a)],
        cwd=str(project_path),
    )
    assert result.returncode == 0, (
        f"set-target-repo failed: {result.stdout}\n{result.stderr}"
    )

    epic_data = _read_epic_json(project_path, epic_id)
    assert epic_data["touched_repos"] == [str(repo_a)], (
        f"touched_repos shrink mismatch: {epic_data['touched_repos']}"
    )


def test_set_target_repo_idempotent_when_same(tmp_path, monkeypatch):
    """set-target-repo with the same value as before leaves touched_repos unchanged."""
    project_path = _create_project(tmp_path, monkeypatch)

    repo_a = tmp_path / "repo-a"
    repo_a.mkdir()
    _init_git_repo(repo_a)
    repo_b = tmp_path / "repo-b"
    repo_b.mkdir()
    _init_git_repo(repo_b)

    epic_id, task_ids = _seed_multi_task_epic_with_repos(
        project_path, str(repo_a), [str(repo_a), str(repo_b)]
    )

    before = _read_epic_json(project_path, epic_id)["touched_repos"]

    # Re-write task[1]'s target_repo to its existing value (B).
    result = _run_planctl(
        ["task", "set-target-repo", task_ids[1], "--path", str(repo_b)],
        cwd=str(project_path),
    )
    assert result.returncode == 0, (
        f"set-target-repo failed: {result.stdout}\n{result.stderr}"
    )

    after = _read_epic_json(project_path, epic_id)["touched_repos"]
    assert after == before == sorted([str(repo_a), str(repo_b)]), (
        f"idempotent mismatch: before={before} after={after}"
    )


def test_set_target_repo_envelope_shape_unchanged(tmp_path, monkeypatch):
    """Envelope still emits {task_id, target_repo} and no new keys (no
    touched_repos field on the envelope itself — that lives on the epic JSON)."""
    project_path = _create_project(tmp_path, monkeypatch)

    repo_a = tmp_path / "repo-a"
    repo_a.mkdir()
    _init_git_repo(repo_a)
    repo_b = tmp_path / "repo-b"
    repo_b.mkdir()
    _init_git_repo(repo_b)

    _epic_id, task_ids = _seed_multi_task_epic_with_repos(
        project_path, str(repo_a), [str(repo_a)]
    )

    result = _run_planctl(
        ["task", "set-target-repo", task_ids[0], "--path", str(repo_b)],
        cwd=str(project_path),
    )
    assert result.returncode == 0, (
        f"set-target-repo failed: {result.stdout}\n{result.stderr}"
    )

    docs = _parse_json_stream(result.stdout)
    # Mutating verbs emit a single compact NDJSON envelope: the business
    # payload merged with `success: True` and a `planctl_invocation` tag.
    assert len(docs) == 1, f"expected one envelope, got {docs}"
    envelope = docs[0]
    # Strip the envelope wrappers; what's left must be exactly the
    # business payload shape.
    business = {
        k: v for k, v in envelope.items() if k not in {"success", "planctl_invocation"}
    }
    assert set(business.keys()) == {"task_id", "target_repo"}, (
        f"envelope shape changed: {sorted(business.keys())}"
    )
    assert business["task_id"] == task_ids[0]
    assert business["target_repo"] == str(repo_b)


# ---------------------------------------------------------------------------
# Negative test: no-restamp verb (done) does not touch last_validated_at
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# samefile defense: mis-location detection and symlink acceptance
# ---------------------------------------------------------------------------


def _create_project_in_git_repo(tmp_path, monkeypatch, subdir_name="project"):
    """Init a planctl project inside a real git repo and return the project path.

    Unlike _create_project(), the directory also gets `git init` so
    _validate_repo_path accepts it and the samefile check has two real inodes
    to compare.
    """
    project_path = tmp_path / subdir_name
    project_path.mkdir()
    _init_git_repo(project_path)
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-validate-marker-fixture")
    monkeypatch.chdir(project_path)
    runner = CliRunner()
    result = runner.invoke(cli, ["init"])
    assert result.exit_code == 0, result.output
    return project_path


def test_validate_rejects_mislocated_primary_repo(tmp_path, monkeypatch):
    """validate --epic rejects an epic whose primary_repo is a genuinely different repo.

    Verifies that the samefile check catches a real mis-location (not just a
    normalization mismatch).  darwin/linux only — symlinks require no special
    permissions on these platforms.
    """
    project_path = _create_project_in_git_repo(tmp_path, monkeypatch)

    # A second, entirely separate git repo — different inode.
    other_repo = tmp_path / "other-repo"
    other_repo.mkdir()
    _init_git_repo(other_repo)

    epic_id = _create_epic_with_primary_repo(project_path, str(other_repo))

    result = _run_validate(project_path, ("--epic", epic_id))
    assert result.returncode == 1, (
        f"validate should exit 1 for mis-located epic, got 0.\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )
    docs = _parse_json_stream(result.stdout)
    assert docs, f"Expected at least one JSON doc in stdout: {result.stdout!r}"
    envelope = docs[0]
    assert envelope.get("valid") is False
    assert any("mis-located" in e for e in envelope.get("errors", [])), (
        f"Expected mis-located error, got: {envelope.get('errors')}"
    )


def test_validate_accepts_primary_repo_via_symlink(tmp_path, monkeypatch):
    """validate --epic accepts primary_repo set to a symlink pointing at the same repo.

    os.path.samefile compares inodes, so a symlink to the project root resolves
    to the same inode as the project root itself — the check must pass.
    darwin/linux only — os.symlink does not require admin on these platforms.
    """
    project_path = _create_project_in_git_repo(tmp_path, monkeypatch)

    # Create a symlink that points at the same real project directory.
    link_path = tmp_path / "link-to-project"
    os.symlink(project_path, link_path)

    # Store the symlink path as primary_repo — samefile should resolve it.
    epic_id = _create_epic_with_primary_repo(project_path, str(link_path))

    result = _run_validate(project_path, ("--epic", epic_id))
    assert result.returncode == 0, (
        f"validate should accept primary_repo via symlink, but exited non-zero.\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )
    docs = _parse_json_stream(result.stdout)
    assert docs, f"Expected at least one JSON doc in stdout: {result.stdout!r}"
    envelope = docs[0]
    assert envelope.get("valid") is True, (
        f"Expected valid=true for symlinked primary_repo, got: {envelope}"
    )
    assert envelope.get("errors", []) == [], (
        f"Expected no errors for symlinked primary_repo, got: {envelope.get('errors')}"
    )


# ---------------------------------------------------------------------------
# epic invalidate tests
# ---------------------------------------------------------------------------


def test_invalidate_clears_marker(tmp_path, monkeypatch):
    """epic invalidate clears last_validated_at on a stamped epic."""
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)
    _stamp_marker(project_path, epic_id)

    # Pre-condition: marker is set.
    epic_before = _read_epic_json(project_path, epic_id)
    assert epic_before.get("last_validated_at") == "2020-01-01T00:00:00Z"

    result = _run_planctl(
        ["epic", "invalidate", epic_id],
        cwd=str(project_path),
    )
    assert result.returncode == 0, (
        f"epic invalidate failed: {result.stdout}\n{result.stderr}"
    )

    # Marker is now null (epic invalidate is the ONLY surviving null path).
    epic_after = _read_epic_json(project_path, epic_id)
    assert epic_after.get("last_validated_at") is None, (
        f"epic invalidate did not null last_validated_at: "
        f"got {epic_after.get('last_validated_at')!r}"
    )

    # Envelope has op=invalidate and planctl_invocation present.
    docs = _parse_json_stream(result.stdout)
    assert len(docs) == 1, f"Expected 1 JSON doc, got {len(docs)}: {result.stdout!r}"
    inv = docs[0].get("planctl_invocation", {})
    assert inv.get("op") == "invalidate", f"Expected op=invalidate: {inv}"
    assert inv.get("target") == epic_id, f"Expected target={epic_id}: {inv}"


def test_invalidate_short_circuits_when_already_null(tmp_path, monkeypatch):
    """epic invalidate on a never-stamped epic short-circuits: no JSON write, no commit
    files in the envelope, but a readonly invocation envelope still lands."""
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)

    # Pre-condition: marker is already None.
    epic_before = _read_epic_json(project_path, epic_id)
    assert epic_before.get("last_validated_at") is None

    result = _run_planctl(
        ["epic", "invalidate", epic_id],
        cwd=str(project_path),
    )
    assert result.returncode == 0, (
        f"epic invalidate short-circuit failed: {result.stdout}\n{result.stderr}"
    )

    # Still emits an envelope (audit row + UDS event fire).
    docs = _parse_json_stream(result.stdout)
    assert len(docs) == 1, f"Expected 1 JSON doc, got {len(docs)}: {result.stdout!r}"
    inv = docs[0].get("planctl_invocation", {})
    assert inv.get("op") == "invalidate", f"Expected op=invalidate: {inv}"

    # Readonly path: files should be None (no commit-relevant files staged).
    assert inv.get("files") is None, (
        f"Short-circuit path must not stage files: {inv.get('files')}"
    )

    # Marker stays null.
    epic_after = _read_epic_json(project_path, epic_id)
    assert epic_after.get("last_validated_at") is None, (
        "Short-circuit must not write last_validated_at"
    )


def test_invalidate_bumps_updated_at(tmp_path, monkeypatch):
    """epic invalidate bumps updated_at when the marker transitions stamped → null."""
    project_path = _create_project(tmp_path, monkeypatch)
    epic_id = _create_epic(project_path)

    # Set a known prior updated_at alongside the marker.
    epic_path = project_path / ".planctl" / "epics" / f"{epic_id}.json"
    data = _read_epic_json(project_path, epic_id)
    prior_updated_at = "2020-01-01T00:00:00Z"
    data["updated_at"] = prior_updated_at
    data["last_validated_at"] = "2020-01-01T00:00:00Z"
    import json as _json

    epic_path.write_text(_json.dumps(data))

    result = _run_planctl(
        ["epic", "invalidate", epic_id],
        cwd=str(project_path),
    )
    assert result.returncode == 0, (
        f"epic invalidate failed: {result.stdout}\n{result.stderr}"
    )

    epic_after = _read_epic_json(project_path, epic_id)
    new_updated_at = epic_after.get("updated_at")
    assert new_updated_at is not None, "updated_at must be set after invalidate"
    assert new_updated_at > prior_updated_at, (
        f"updated_at must be newer than {prior_updated_at!r}, got {new_updated_at!r}"
    )


def test_invalidate_not_in_validation_restamp_verbs():
    """invalidate must NOT be in VALIDATION_RESTAMP_VERBS.

    VALIDATION_RESTAMP_VERBS captures verbs that re-stamp last_validated_at as a
    side-effect of structural mutation (task/dep/spec changes). epic invalidate's
    PRIMARY job is the explicit clear — it does not change task/dep/spec structure.
    Keeping it out of the tuple prevents a future contributor from accidentally
    treating it as an implicit side-effect clearer when auditing that tuple.
    The dedicated behavior is tested above; this test documents the carve-out.
    """
    assert "invalidate" not in VALIDATION_RESTAMP_VERBS, (
        "'invalidate' must not appear in VALIDATION_RESTAMP_VERBS — "
        "its primary job is the explicit clear, not a side-effect. "
        "See apps/planctl/CLAUDE.md and commit-at-mutation-boundary.md."
    )


def test_done_does_not_clear_marker(tmp_path, monkeypatch):
    """planctl done does NOT clear last_validated_at (it's not a structural mutation)."""
    project_path, epic_id, task_id = _setup_epic_and_task(tmp_path, monkeypatch)

    # claim is required before done. --project bypasses roots discovery
    # (fn-542 task .3): claim is cwd-agnostic and resolves the project via roots.
    claim_result = _run_planctl(
        ["claim", task_id, "--project", str(project_path)], cwd=str(project_path)
    )
    assert claim_result.returncode == 0, (
        f"claim failed: {claim_result.stdout}\n{claim_result.stderr}"
    )

    _stamp_marker(project_path, epic_id)

    result = _run_planctl(
        ["done", task_id, "--summary", "Test done"],
        cwd=str(project_path),
    )
    assert result.returncode == 0, f"done failed: {result.stdout}\n{result.stderr}"

    epic_data = _read_epic_json(project_path, epic_id)
    assert epic_data.get("last_validated_at") == "2020-01-01T00:00:00Z", (
        f"done must not clear last_validated_at, but got: "
        f"{epic_data.get('last_validated_at')!r}"
    )
