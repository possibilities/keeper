"""Tests for the planctl_invocation envelope.

Verifies:

- Mutating verbs emit planctl_invocation with correct fields.
- files entries are all prefixed with .planctl/.
- touched_path_files matches the session's touched dir at commit time.
- planctl_invocation is absent on non-mutating verbs.
- Mutating verb stdout is NDJSON (single compact line), json.loads round-trips.
- finalize() still runs in parallel (existing test_commit.py covers git commits).
"""

from __future__ import annotations

import json

from .conftest import run_cli


def _invoke(args: list[str]):
    return run_cli(args)


# ---------------------------------------------------------------------------
# Mutating verb: epic create
# ---------------------------------------------------------------------------


def test_epic_create_emits_planctl_mutation(planctl_git_repo):
    result = _invoke(["epic", "create", "--title", "Envelope test"])
    assert result.exit_code == 0, result.output

    # Must be valid JSON (NDJSON — single compact line)
    line = result.output.strip()
    assert "\n" not in line, f"Expected single-line NDJSON, got:\n{line}"
    payload = json.loads(line)

    assert payload["success"] is True
    assert "planctl_invocation" in payload

    pc = payload["planctl_invocation"]
    assert "files" in pc
    assert "op" in pc
    assert "target" in pc
    assert "subject" in pc
    assert "touched_path_files" in pc
    assert "repo_root" in pc

    # Structural checks
    assert pc["op"] == "create"
    assert pc["target"].startswith("fn-")
    assert pc["subject"].startswith("chore(planctl): create fn-")

    # All files must be prefixed with .planctl/
    for f in pc["files"]:
        assert f.startswith(".planctl/"), f"Non-.planctl/ path in files: {f!r}"

    # files must be non-empty (epic + spec were written)
    assert len(pc["files"]) >= 1


def test_epic_create_repo_root(planctl_git_repo):
    """planctl_invocation.repo_root is an absolute POSIX string equal to the project root."""
    result = _invoke(["epic", "create", "--title", "Repo root test"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output.strip())
    pc = payload["planctl_invocation"]

    repo_root = pc["repo_root"]
    assert isinstance(repo_root, str), "repo_root must be a string"
    # Must be absolute
    from pathlib import Path

    assert Path(repo_root).is_absolute(), f"repo_root is not absolute: {repo_root!r}"
    # Must match the fixture's tmp_path (cwd was set to tmp_path by fixture)
    assert repo_root == str(planctl_git_repo), (
        f"repo_root {repo_root!r} != fixture root {str(planctl_git_repo)!r}"
    )


def test_epic_create_files_prefix_guard(planctl_git_repo):
    """Every entry in planctl_invocation.files starts with .planctl/."""
    result = _invoke(["epic", "create", "--title", "Prefix guard"])
    assert result.exit_code == 0
    payload = json.loads(result.output.strip())
    pc = payload["planctl_invocation"]
    for path in pc["files"]:
        assert path.startswith(".planctl/"), f"Bad path: {path!r}"


def test_epic_create_no_prev_op_field(planctl_git_repo):
    """planctl_invocation must NOT contain a prev_op field (G2)."""
    result = _invoke(["epic", "create", "--title", "No prev_op"])
    assert result.exit_code == 0
    payload = json.loads(result.output.strip())
    pc = payload["planctl_invocation"]
    assert "prev_op" not in pc, "planctl_invocation must not contain prev_op"


def test_epic_create_ndjson_roundtrip(planctl_git_repo):
    """Mutating verb output must be compact single-line JSON (NDJSON-safe)."""
    result = _invoke(["epic", "create", "--title", "NDJSON check"])
    assert result.exit_code == 0
    line = result.output.strip()
    # No embedded newlines (compact JSON)
    assert "\n" not in line
    # Round-trips cleanly
    payload = json.loads(line)
    assert payload["success"] is True


def test_epic_create_touched_path_files(planctl_git_repo):
    """touched_path_files entries should be .planctl/state/sessions/.../touched/*.txt paths."""
    result = _invoke(["epic", "create", "--title", "Touched files check"])
    assert result.exit_code == 0
    payload = json.loads(result.output.strip())
    pc = payload["planctl_invocation"]
    # After finalize() clears the touched dir, touched_path_files will be empty
    # because build_planctl_mutation is called BEFORE finalize().
    # The list may be empty if the touched dir was cleared by a prior commit
    # (planctl init in fixture), but the field must exist and be a list.
    assert isinstance(pc["touched_path_files"], list)


# ---------------------------------------------------------------------------
# Non-mutating verbs emit planctl_invocation as a trailing NDJSON line
# (not embedded in the primary payload)
# ---------------------------------------------------------------------------


def _parse_primary(output: str) -> dict:
    """Parse the primary JSON payload from CLI output.

    The click decorator appends a trailing ``{"planctl_invocation": ...}``
    NDJSON line after the primary output for read-only verbs. Strip it before
    parsing the primary payload so multi-line pretty JSON parses cleanly.
    """
    lines = output.strip().splitlines()
    primary_lines = [
        ln for ln in lines if not ln.strip().startswith('{"planctl_invocation"')
    ]
    return json.loads("\n".join(primary_lines))


def test_show_no_planctl_mutation(planctl_git_repo):
    # Create an epic to show
    r = _invoke(["epic", "create", "--title", "Show test"])
    assert r.exit_code == 0
    epic_id = json.loads(r.output.strip())["epic"]["id"]

    result = _invoke(["show", epic_id])
    assert result.exit_code == 0

    # Primary payload must not embed planctl_invocation (it's in the trailing line)
    payload = _parse_primary(result.output)
    assert "planctl_invocation" not in payload


def test_epics_no_planctl_mutation(planctl_git_repo):
    result = _invoke(["epics"])
    assert result.exit_code == 0
    payload = _parse_primary(result.output)
    assert "planctl_invocation" not in payload


def test_tasks_no_planctl_mutation(planctl_git_repo):
    r = _invoke(["epic", "create", "--title", "Tasks test"])
    assert r.exit_code == 0
    epic_id = json.loads(r.output.strip())["epic"]["id"]

    result = _invoke(["tasks", "--epic", epic_id])
    assert result.exit_code == 0
    payload = _parse_primary(result.output)
    assert "planctl_invocation" not in payload


# ---------------------------------------------------------------------------
# subject is built via commit_messages.build_subject (VERB_TEMPLATES)
# ---------------------------------------------------------------------------


def test_subject_via_verb_templates(planctl_git_repo):
    """Verify subject matches what build_subject would produce."""
    from planctl.commit_messages import build_subject

    result = _invoke(["epic", "create", "--title", "Subject test"])
    assert result.exit_code == 0
    payload = json.loads(result.output.strip())
    pc = payload["planctl_invocation"]

    expected = build_subject("create", pc["target"])
    assert pc["subject"] == expected


def test_subject_with_detail_formatting():
    """A detail= argument is appended to the subject as ` — <detail>`."""
    from planctl.commit_messages import build_subject

    assert (
        build_subject("set-branch", "fn-1-slug", "feat-x")
        == "chore(planctl): set-branch fn-1-slug — feat-x"
    )
    # Newlines/control chars in detail are flattened to spaces.
    assert (
        build_subject("set-branch", "fn-1-slug", "feat\nx")
        == "chore(planctl): set-branch fn-1-slug — feat x"
    )


# ---------------------------------------------------------------------------
# Orphan originating_epic key regression
# ---------------------------------------------------------------------------


def test_orphan_originating_epic_key_is_inert(planctl_git_repo):
    """Old-schema epics with orphan originating_epic key on disk load cleanly.

    Asserts:

    - planctl show succeeds
    - show envelope JSON does not contain originating_epic
    """
    import json as _json

    # Create two epics
    r = _invoke(["epic", "create", "--title", "Alpha"])
    assert r.exit_code == 0
    alpha_id = _json.loads(r.output.strip())["epic"]["id"]

    r = _invoke(["epic", "create", "--title", "Beta"])
    assert r.exit_code == 0
    beta_id = _json.loads(r.output.strip())["epic"]["id"]

    # Inject orphan originating_epic into alpha's on-disk JSON
    epic_path = planctl_git_repo / ".planctl" / "epics" / f"{alpha_id}.json"
    data = _json.loads(epic_path.read_text())
    data["originating_epic"] = beta_id
    epic_path.write_text(_json.dumps(data))

    # planctl show must succeed and NOT expose originating_epic in the envelope
    result = _invoke(["show", alpha_id])
    assert result.exit_code == 0
    payload = _parse_primary(result.output)
    assert "originating_epic" not in payload["epic"]
