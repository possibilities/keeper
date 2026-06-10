"""Tests for `planctl followup submit <epic_id>` (fn-12 task .2).

The followup-submit verb validates the close-planner's follow-up plan YAML via
scaffold's DRY-RUN semantics — the assert-all half of scaffold's flow, reusing
its leaf checkers + failure-code priority, WITHOUT the mutate phase (mints
nothing, needs no CLAUDE_CODE_SESSION_ID) — then cross-checks the YAML task count
against the persisted verdict's distinct non-null kept/merged ordinals. On
success it persists the YAML commit-free under `audits/<epic_id>/followup.yaml`.

Coverage (per the task's Test notes):
- happy path persists + envelope shape (task_count == expected)
- count mismatch vs the verdict's distinct ordinals → TASK_COUNT_MISMATCH
- scaffold-invalid YAML surfaces scaffold's own codes (bad_yaml / spec_invalid /
  tier_invalid / dep_cycle) verbatim
- no CLAUDE_CODE_SESSION_ID required (the dry-run mints nothing)
- missing verdict → VERDICT_MISSING; missing brief → BRIEF_MISSING; oversize stdin
- the dry-run validator matches scaffold's verdict on the same YAML (divergence guard)
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from click.testing import CliRunner
from planctl.audit_artifacts import (
    brief_path,
    compute_commit_set_hash,
    verdict_path,
    write_artifact,
)
from planctl.cli import cli
from planctl.run_scaffold import validate_scaffold_yaml

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_TASK_SPEC_LINES = (
    "## Description",
    "x",
    "## Acceptance",
    "- [ ] x",
    "## Done summary",
    "## Evidence",
)


def _envelope(output: str) -> dict:
    payload_keys = ("success", "error", "followup_ref")
    decoder = json.JSONDecoder()
    idx = 0
    while idx < len(output):
        brace = output.find("{", idx)
        if brace == -1:
            break
        try:
            obj, end = decoder.raw_decode(output, brace)
        except json.JSONDecodeError:
            idx = brace + 1
            continue
        if any(k in obj for k in payload_keys):
            return obj
        idx = end
    raise AssertionError(f"no envelope found in {output!r}")


@pytest.fixture
def source_epic(project) -> str:
    """Scaffold a real one-task source epic and return its minted id.

    The follow-up plan's `depends_on_epics: [<source>]` resolves against this
    real on-disk epic — close always runs against an existing all-done epic, so
    the dry-run's epic-dep existence check has a real target here too.
    """
    yaml_text = (
        "epic:\n  title: Source epic\n  spec: |\n    ## Overview\n    src\ntasks:\n"
        "  - title: t1\n    tier: medium\n    spec: |\n"
        + "\n".join("      " + ln for ln in _TASK_SPEC_LINES)
        + "\n"
    )
    plan = project / "src.yaml"
    plan.write_text(yaml_text)
    r = CliRunner().invoke(cli, ["scaffold", "--file", str(plan)])
    assert r.exit_code == 0, r.output
    return json.loads(r.output.strip().splitlines()[0])["epic_id"]


def _seed_brief(project: Path, epic_id: str):
    h = compute_commit_set_hash([{"repo": str(project), "shas": ["abc123"]}])
    brief = {
        "schema_version": 1,
        "epic_id": epic_id,
        "primary_repo": str(project),
        "commit_set_hash": h,
        "commit_groups": [],
        "snippet_context": "",
        "tasks": [],
    }
    write_artifact(brief_path(project, epic_id), json.dumps(brief) + "\n")
    return h


def _seed_verdict(project: Path, epic_id: str, *, ordinals: list[int]):
    """Persist a verdict whose kept decisions occupy *ordinals* (distinct count
    = the expected follow-up cluster count)."""
    decisions = [
        {"fid": f"f{i}", "action": "kept", "task": o, "rationale": "r"}
        for i, o in enumerate(ordinals, start=1)
    ]
    record = {
        "schema_version": 1,
        "commit_set_hash": "h",
        "fatal": False,
        "fatal_reason": "",
        "decisions": decisions,
    }
    write_artifact(verdict_path(project, epic_id), json.dumps(record) + "\n")


def _followup_yaml(
    n_tasks: int,
    *,
    source: str | None = None,
    deps: dict[int, list[int]] | None = None,
) -> str:
    """A scaffold-valid follow-up YAML with *n_tasks* well-formed task entries."""
    deps = deps or {}
    lines = ["epic:", "  title: Follow up"]
    if source is not None:
        lines.append(f"  depends_on_epics: [{source}]")
    lines += ["  spec: |", "    ## Overview", "    fu", "tasks:"]
    for i in range(1, n_tasks + 1):
        lines.append(f"  - title: task {i}")
        lines.append("    tier: medium")
        if i in deps:
            lines.append(f"    deps: [{', '.join(str(d) for d in deps[i])}]")
        lines.append("    spec: |")
        lines += ["      " + ln for ln in _TASK_SPEC_LINES]
    return "\n".join(lines) + "\n"


def _submit(project, epic_id: str, yaml_text: str):
    return CliRunner().invoke(
        cli, ["followup", "submit", epic_id, "--file", "-"], input=yaml_text
    )


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_happy_path_persists(project, source_epic):
    h = _seed_brief(project, source_epic)
    _seed_verdict(project, source_epic, ordinals=[1])
    yaml_text = _followup_yaml(1, source=source_epic)
    r = _submit(project, source_epic, yaml_text)
    assert r.exit_code == 0, r.output
    env = _envelope(r.output)
    assert env["task_count"] == 1
    assert env["expected_tasks"] == 1
    assert env["commit_set_hash"] == h
    assert Path(env["followup_ref"]).read_text() == yaml_text
    meta = json.loads(Path(env["meta_ref"]).read_text())
    assert meta["commit_set_hash"] == h
    assert meta["task_count"] == 1


def test_merged_ordinals_collapse_to_distinct_count(project, source_epic):
    """Two findings merged into the same ordinal expect ONE follow-up task."""
    _seed_brief(project, source_epic)
    # f1 kept→1, f2 merged-into-f1→1: distinct ordinals = {1} → expect 1 task.
    record = {
        "schema_version": 1,
        "commit_set_hash": "h",
        "fatal": False,
        "fatal_reason": "",
        "decisions": [
            {"fid": "f1", "action": "kept", "task": 1, "rationale": "r"},
            {"fid": "f2", "action": "merged-into-f1", "task": 1, "rationale": "r"},
        ],
    }
    write_artifact(verdict_path(project, source_epic), json.dumps(record) + "\n")
    r = _submit(project, source_epic, _followup_yaml(1, source=source_epic))
    assert r.exit_code == 0, r.output
    assert _envelope(r.output)["expected_tasks"] == 1


# ---------------------------------------------------------------------------
# Count mismatch
# ---------------------------------------------------------------------------


def test_count_mismatch_rejects(project, source_epic):
    _seed_brief(project, source_epic)
    _seed_verdict(project, source_epic, ordinals=[1, 2])  # expect 2
    r = _submit(project, source_epic, _followup_yaml(1, source=source_epic))  # plan: 1
    assert r.exit_code == 1
    env = _envelope(r.output)
    assert env["error"]["code"] == "TASK_COUNT_MISMATCH"
    assert env["error"]["details"]["actual_tasks"] == 1
    assert env["error"]["details"]["expected_tasks"] == 2


# ---------------------------------------------------------------------------
# Scaffold-invalid YAML surfaces scaffold's codes verbatim
# ---------------------------------------------------------------------------


def test_missing_tier_surfaces_scaffold_code(project, source_epic):
    _seed_brief(project, source_epic)
    _seed_verdict(project, source_epic, ordinals=[1])
    yaml_text = (
        f"epic:\n  title: FU\n  depends_on_epics: [{source_epic}]\n  spec: |\n"
        "    ## Overview\n    x\ntasks:\n"
        "  - title: t1\n    spec: |\n"
        "      ## Description\n      x\n      ## Acceptance\n"
        "      - [ ] x\n      ## Done summary\n      ## Evidence\n"
    )
    r = _submit(project, source_epic, yaml_text)
    assert r.exit_code == 1
    assert _envelope(r.output)["error"]["code"] == "tier_invalid"


def test_bad_yaml_shape_surfaces_scaffold_code(project, source_epic):
    _seed_brief(project, source_epic)
    _seed_verdict(project, source_epic, ordinals=[1])
    r = _submit(project, source_epic, "not a mapping\n")
    assert r.exit_code == 1
    assert _envelope(r.output)["error"]["code"] == "bad_yaml"


def test_invalid_spec_surfaces_scaffold_code(project, source_epic):
    _seed_brief(project, source_epic)
    _seed_verdict(project, source_epic, ordinals=[1])
    # A task spec missing the required sections fails ensure_valid_task_spec.
    yaml_text = (
        f"epic:\n  title: FU\n  depends_on_epics: [{source_epic}]\n  spec: |\n"
        "    ## Overview\n    x\ntasks:\n"
        "  - title: t1\n    tier: medium\n    spec: |\n      just prose, no sections\n"
    )
    r = _submit(project, source_epic, yaml_text)
    assert r.exit_code == 1
    assert _envelope(r.output)["error"]["code"] == "spec_invalid"


def test_dep_cycle_surfaces_scaffold_code(project, source_epic):
    _seed_brief(project, source_epic)
    _seed_verdict(project, source_epic, ordinals=[1, 2])
    # task1 deps on 2, task2 deps on 1 → cycle.
    r = _submit(
        project,
        source_epic,
        _followup_yaml(2, source=source_epic, deps={1: [2], 2: [1]}),
    )
    assert r.exit_code == 1
    assert _envelope(r.output)["error"]["code"] == "dep_cycle"


# ---------------------------------------------------------------------------
# No session-id required (the dry-run mints nothing)
# ---------------------------------------------------------------------------


def test_no_session_id_required(project, source_epic, monkeypatch):
    _seed_brief(project, source_epic)
    _seed_verdict(project, source_epic, ordinals=[1])
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
    r = _submit(project, source_epic, _followup_yaml(1, source=source_epic))
    assert r.exit_code == 0, r.output
    assert _envelope(r.output)["task_count"] == 1


# ---------------------------------------------------------------------------
# Missing prerequisites / oversize
# ---------------------------------------------------------------------------


def test_missing_verdict_rejects(project, source_epic):
    _seed_brief(project, source_epic)
    r = _submit(project, source_epic, _followup_yaml(1, source=source_epic))
    assert r.exit_code == 1
    assert _envelope(r.output)["error"]["code"] == "VERDICT_MISSING"


def test_missing_brief_rejects(project, source_epic):
    r = _submit(project, source_epic, _followup_yaml(1, source=source_epic))
    assert r.exit_code == 1
    assert _envelope(r.output)["error"]["code"] == "BRIEF_MISSING"


def test_oversize_stdin_rejects(project, source_epic):
    _seed_brief(project, source_epic)
    _seed_verdict(project, source_epic, ordinals=[1])
    r = _submit(project, source_epic, "x" * (1 * 1024 * 1024 + 1))
    assert r.exit_code == 1
    assert _envelope(r.output)["error"]["code"] == "PAYLOAD_TOO_LARGE"


# ---------------------------------------------------------------------------
# Divergence guard: the dry-run validator agrees with scaffold on the same YAML
# ---------------------------------------------------------------------------


def test_dryrun_validator_accepts_scaffold_valid_yaml(project):
    """A YAML scaffold accepts must pass the dry-run validator (and vice versa)."""
    yaml_text = _followup_yaml(2, deps={2: [1]})
    result = validate_scaffold_yaml(
        yaml_text.encode("utf-8"), file_label="t", check_epic_deps=False
    )
    assert result.ok, result.details
    assert result.n_tasks == 2

    # And scaffold itself mints it cleanly (same leaf checkers).
    plan = project / "fu.yaml"
    plan.write_text(yaml_text)
    r = CliRunner().invoke(cli, ["scaffold", "--file", str(plan)])
    assert r.exit_code == 0, r.output


def test_dryrun_validator_rejects_what_scaffold_rejects(project):
    """A tier-less task is rejected by both the dry-run and scaffold (same code)."""
    yaml_text = (
        "epic:\n  title: FU\n  spec: |\n    ## Overview\n    x\ntasks:\n"
        "  - title: t1\n    spec: |\n"
        "      ## Description\n      x\n      ## Acceptance\n"
        "      - [ ] x\n      ## Done summary\n      ## Evidence\n"
    )
    dry = validate_scaffold_yaml(yaml_text.encode("utf-8"), file_label="t")
    assert not dry.ok
    assert dry.code == "tier_invalid"

    plan = project / "bad.yaml"
    plan.write_text(yaml_text)
    r = CliRunner().invoke(cli, ["scaffold", "--file", str(plan)])
    assert r.exit_code != 0
    assert (
        json.loads(r.output.strip().splitlines()[0])["error"]["code"] == "tier_invalid"
    )


@pytest.mark.real_git
def test_no_commit_fires(project, source_epic):
    _seed_brief(project, source_epic)
    _seed_verdict(project, source_epic, ordinals=[1])
    head_before = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=project, capture_output=True, text=True
    ).stdout.strip()
    r = _submit(project, source_epic, _followup_yaml(1, source=source_epic))
    assert r.exit_code == 0, r.output
    head_after = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=project, capture_output=True, text=True
    ).stdout.strip()
    assert head_after == head_before
