"""Tests for `planctl close-finalize <epic_id>`.

`close-finalize` encodes the /plan:close saga in Python, deriving its position
purely from observable state (the persisted audit artifacts + the epic's own
status). Every reversible check runs FIRST; the irreversible `epic close`
mutation runs LAST, so a crash mid-saga leaves the source epic OPEN and the verb
re-runnable.

Coverage (per the task's Test notes):
- Truth-table tests per outcome arm (closed_clean / closed_with_followup /
  fatal_halt / partial_followup).
- Idempotent re-run after each terminal outcome returns the SAME outcome.
- Crash-resume: a follow-up already scaffolded but the epic not yet closed →
  the adopt path (found+complete), then close.
- Stale-hash refusal (STALE_ARTIFACTS).
- Missing verdict / missing followup fail-closed.
- Partial follow-up stops without scaffold or close.
- Exhaustiveness test: every CloseOutcome member has a skill handler.
- `epic followup-of` verb is gone (unknown subcommand).
"""

from __future__ import annotations

import json
from pathlib import Path

from planctl.audit_artifacts import (
    AUDIT_SCHEMA_VERSION,
    compute_commit_set_hash,
    followup_path,
    report_meta_path,
    verdict_path,
    write_artifact,
    write_brief_artifact,
)

from .conftest import run_cli, seed_epic

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _empty_set_hash() -> str:
    """The commit_set_hash finalize re-derives for an epic with no source commits.

    The seeded tasks carry no `Task:` trailer commits, so `find_commit_groups`
    returns `[]` and the canonical hash is over the empty commit set. Stamping
    this into the verdict makes the freshness check pass.
    """
    return compute_commit_set_hash([])


def _envelope(output: str) -> dict:
    """First JSON object on stdout carrying a payload key (skips the invocation line)."""
    payload_keys = ("outcome", "success", "error")
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


def _mark_all_done(repo: Path, task_ids: list[str]) -> None:
    """Mark every task `done` via the runtime sidecar so the epic is closeable.

    Writes the gitignored runtime state directly (bypasses the claim/done state
    machine) — `merge_task_state` reads it and `epic close` honors it. Mirrors
    `tests/test_reconcile._set_runtime`.
    """
    for tid in task_ids:
        state_path = repo / ".planctl" / "state" / "tasks" / f"{tid}.state.json"
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps({"status": "done"}) + "\n", encoding="utf-8")


def _seed_brief(repo: Path, epic_id: str, commit_set_hash: str) -> None:
    brief = {
        "schema_version": 1,
        "epic_id": epic_id,
        "primary_repo": str(repo),
        "commit_set_hash": commit_set_hash,
        "commit_groups": [],
        "snippet_context": "",
        "tasks": [],
    }
    write_brief_artifact(repo, epic_id, brief)


def _seed_verdict(
    repo: Path,
    epic_id: str,
    *,
    commit_set_hash: str,
    fatal: bool = False,
    fatal_reason: str = "",
    decisions: list[dict] | None = None,
) -> None:
    record = {
        "schema_version": 1,
        "commit_set_hash": commit_set_hash,
        "fatal": fatal,
        "fatal_reason": fatal_reason,
        "decisions": decisions or [],
    }
    write_artifact(
        verdict_path(repo, epic_id), json.dumps(record, indent=2, sort_keys=True) + "\n"
    )


def _seed_report_meta(
    repo: Path, epic_id: str, commit_set_hash: str, findings: int, risk: str = "Low"
) -> None:
    meta = {
        "schema_version": AUDIT_SCHEMA_VERSION,
        "epic_id": epic_id,
        "commit_set_hash": commit_set_hash,
        "findings": findings,
        "risk": risk,
    }
    write_artifact(
        report_meta_path(repo, epic_id),
        json.dumps(meta, indent=2, sort_keys=True) + "\n",
    )


def _seed_followup_yaml(repo: Path, epic_id: str, source_epic_id: str, n_tasks: int):
    """Write a valid scaffold-plan followup.yaml wiring back to the source epic."""
    blocks = []
    for i in range(1, n_tasks + 1):
        spec = (
            "      ## Description\n      follow-up\n\n"
            "      ## Acceptance\n      - [ ] x\n\n"
            "      ## Done summary\n\n      ## Evidence\n"
        )
        blocks.append(
            f"  - title: Follow task {i}\n    tier: medium\n    spec: |\n{spec}"
        )
    yaml = (
        f"epic:\n  title: Follow-up of {source_epic_id}\n"
        f"  depends_on_epics: [{source_epic_id}]\n"
        "  spec: |\n    ## Overview\n    follow overview\n"
        "tasks:\n" + "\n".join(blocks) + "\n"
    )
    write_artifact(followup_path(repo, epic_id), yaml)


def _finalize(epic_id: str):
    return run_cli(["close-finalize", epic_id])


def _epic_status(repo: Path, epic_id: str) -> str:
    return json.loads(
        (repo / ".planctl" / "epics" / f"{epic_id}.json").read_text(encoding="utf-8")
    )["status"]


# ---------------------------------------------------------------------------
# Outcome: closed_clean (zero surviving decisions)
# ---------------------------------------------------------------------------


def test_closed_clean_empty_decisions(planctl_git_repo):
    repo = planctl_git_repo
    epic_id, task_ids = seed_epic(repo, title="Clean close", n_tasks=2)
    _mark_all_done(repo, task_ids)
    h = _empty_set_hash()
    _seed_brief(repo, epic_id, h)
    _seed_verdict(repo, epic_id, commit_set_hash=h, decisions=[])

    r = _finalize(epic_id)
    assert r.exit_code == 0, r.output
    env = _envelope(r.output)
    assert env["outcome"] == "closed_clean"
    assert env["epic_id"] == epic_id
    assert "new_epic_id" not in env
    assert _epic_status(repo, epic_id) == "done"


def test_closed_clean_all_culled(planctl_git_repo):
    repo = planctl_git_repo
    epic_id, task_ids = seed_epic(repo, title="All culled", n_tasks=1)
    _mark_all_done(repo, task_ids)
    h = _empty_set_hash()
    _seed_brief(repo, epic_id, h)
    _seed_verdict(
        repo,
        epic_id,
        commit_set_hash=h,
        decisions=[
            {"fid": "f1", "action": "culled", "task": None, "rationale": "noise"}
        ],
    )

    r = _finalize(epic_id)
    assert r.exit_code == 0, r.output
    assert _envelope(r.output)["outcome"] == "closed_clean"
    assert _epic_status(repo, epic_id) == "done"


def test_closed_clean_idempotent_rerun(planctl_git_repo):
    repo = planctl_git_repo
    epic_id, task_ids = seed_epic(repo, title="Clean idempotent", n_tasks=1)
    _mark_all_done(repo, task_ids)
    h = _empty_set_hash()
    _seed_brief(repo, epic_id, h)
    _seed_verdict(repo, epic_id, commit_set_hash=h, decisions=[])

    first = _envelope(_finalize(epic_id).output)
    assert first["outcome"] == "closed_clean"
    # Re-run on the now-done epic returns the SAME terminal outcome, no error.
    second = _envelope(_finalize(epic_id).output)
    assert second["outcome"] == "closed_clean"
    assert second["epic_id"] == epic_id


# ---------------------------------------------------------------------------
# Outcome: fatal_halt
# ---------------------------------------------------------------------------


def test_fatal_halt_does_not_close(planctl_git_repo):
    repo = planctl_git_repo
    epic_id, task_ids = seed_epic(repo, title="Fatal", n_tasks=1)
    _mark_all_done(repo, task_ids)
    h = _empty_set_hash()
    _seed_brief(repo, epic_id, h)
    _seed_verdict(
        repo,
        epic_id,
        commit_set_hash=h,
        fatal=True,
        fatal_reason="ships a data-loss bug",
        decisions=[],
    )

    r = _finalize(epic_id)
    assert r.exit_code == 0, r.output
    env = _envelope(r.output)
    assert env["outcome"] == "fatal_halt"
    assert env["fatal_reason"] == "ships a data-loss bug"
    # The epic stays OPEN — no close on a fatal verdict.
    assert _epic_status(repo, epic_id) == "open"


# ---------------------------------------------------------------------------
# Outcome: closed_with_followup (scaffold path)
# ---------------------------------------------------------------------------


def test_closed_with_followup_scaffolds_and_closes(planctl_git_repo):
    repo = planctl_git_repo
    epic_id, task_ids = seed_epic(repo, title="Needs followup", n_tasks=1)
    _mark_all_done(repo, task_ids)
    h = _empty_set_hash()
    _seed_brief(repo, epic_id, h)
    _seed_verdict(
        repo,
        epic_id,
        commit_set_hash=h,
        decisions=[{"fid": "f1", "action": "kept", "task": 1, "rationale": "real"}],
    )
    _seed_followup_yaml(repo, epic_id, epic_id, n_tasks=1)

    r = _finalize(epic_id)
    assert r.exit_code == 0, r.output
    env = _envelope(r.output)
    assert env["outcome"] == "closed_with_followup"
    new_epic_id = env["new_epic_id"]
    assert new_epic_id and new_epic_id != epic_id
    assert _epic_status(repo, epic_id) == "done"
    # The follow-up epic exists on disk and wires back to the source.
    new_def = json.loads(
        (repo / ".planctl" / "epics" / f"{new_epic_id}.json").read_text(
            encoding="utf-8"
        )
    )
    assert epic_id in new_def.get("depends_on_epics", [])
    # The minted follow-up carries the positive close-provenance stamp,
    # written in the same atomic write as the rest of the epic.
    assert new_def.get("created_by_close_of") == epic_id


def test_preexisting_dependent_without_stamp_ignored(planctl_git_repo):
    """Regression: an unrelated open dependent (dep edge, no stamp, wrong
    task count) is NOT adopted as the audit follow-up.

    Without positive provenance, ``_find_followup_epic`` would match any open
    epic whose ``depends_on_epics`` contained the source, falsely adopting
    human-planned dependents and wedging the close in perpetual
    ``partial_followup``. With
    positive provenance, an open dependent lacking the ``created_by_close_of``
    stamp is invisible — finalize ignores it, scaffolds the REAL follow-up, and
    closes the source ``closed_with_followup`` with the freshly-minted id.
    """
    repo = planctl_git_repo
    epic_id, task_ids = seed_epic(repo, title="Has innocent dependent", n_tasks=1)
    _mark_all_done(repo, task_ids)
    h = _empty_set_hash()
    _seed_brief(repo, epic_id, h)
    _seed_verdict(
        repo,
        epic_id,
        commit_set_hash=h,
        decisions=[{"fid": "f1", "action": "kept", "task": 1, "rationale": "real"}],
    )
    _seed_followup_yaml(repo, epic_id, epic_id, n_tasks=1)
    # An unrelated human-planned epic that legitimately depends on the source —
    # open, NO close-provenance stamp, and a DIFFERENT task count than expected
    # (would have wedged the count gate at partial_followup under the old
    # dep-edge heuristic).
    innocent_id, _ = seed_epic(repo, title="Innocent dependent", n_tasks=3)
    inn_path = repo / ".planctl" / "epics" / f"{innocent_id}.json"
    inn_def = json.loads(inn_path.read_text(encoding="utf-8"))
    inn_def["depends_on_epics"] = [epic_id]
    inn_path.write_text(json.dumps(inn_def), encoding="utf-8")

    r = _finalize(epic_id)
    assert r.exit_code == 0, r.output
    env = _envelope(r.output)
    # The innocent dependent is ignored; a fresh follow-up is scaffolded.
    assert env["outcome"] == "closed_with_followup"
    new_epic_id = env["new_epic_id"]
    assert new_epic_id not in (epic_id, innocent_id)
    assert _epic_status(repo, epic_id) == "done"
    new_def = json.loads(
        (repo / ".planctl" / "epics" / f"{new_epic_id}.json").read_text(
            encoding="utf-8"
        )
    )
    assert new_def.get("created_by_close_of") == epic_id


def test_plain_scaffold_does_not_stamp_provenance(planctl_git_repo):
    """A plain ``planctl scaffold`` (no internal arg) mints epics without the
    provenance field stamped to a source id — only the close saga stamps it."""
    repo = planctl_git_repo
    epic_id, _ = seed_epic(repo, title="Hand authored", n_tasks=1)
    epic_def = json.loads(
        (repo / ".planctl" / "epics" / f"{epic_id}.json").read_text(encoding="utf-8")
    )
    # Absent or None are both acceptable; what matters is it is not a source id.
    assert epic_def.get("created_by_close_of") is None


def test_closed_with_followup_idempotent_rerun(planctl_git_repo):
    repo = planctl_git_repo
    epic_id, task_ids = seed_epic(repo, title="Followup idempotent", n_tasks=1)
    _mark_all_done(repo, task_ids)
    h = _empty_set_hash()
    _seed_brief(repo, epic_id, h)
    _seed_verdict(
        repo,
        epic_id,
        commit_set_hash=h,
        decisions=[{"fid": "f1", "action": "kept", "task": 1, "rationale": "real"}],
    )
    _seed_followup_yaml(repo, epic_id, epic_id, n_tasks=1)

    first = _envelope(_finalize(epic_id).output)
    assert first["outcome"] == "closed_with_followup"
    new_id = first["new_epic_id"]
    # Re-run on the now-done epic returns the SAME outcome + same new_epic_id,
    # WITHOUT scaffolding a second follow-up.
    second = _envelope(_finalize(epic_id).output)
    assert second["outcome"] == "closed_with_followup"
    assert second["new_epic_id"] == new_id


def test_crash_resume_adopts_scaffolded_followup(planctl_git_repo):
    """A follow-up already scaffolded but the epic not yet closed → adopt + close.

    Simulates a crash between scaffold and close: the follow-up tree is on disk
    (open, complete task count) while the source epic is still open. The re-run
    must take the found+complete adopt path, NOT scaffold a duplicate.
    """
    repo = planctl_git_repo
    epic_id, task_ids = seed_epic(repo, title="Crash resume", n_tasks=1)
    _mark_all_done(repo, task_ids)
    h = _empty_set_hash()
    _seed_brief(repo, epic_id, h)
    _seed_verdict(
        repo,
        epic_id,
        commit_set_hash=h,
        decisions=[{"fid": "f1", "action": "kept", "task": 1, "rationale": "real"}],
    )
    # Pre-create the follow-up (the crashed run's scaffold landed) carrying the
    # close-provenance stamp + exactly 1 task = the expected cluster count. The
    # dep edge is incidental; discovery keys on ``created_by_close_of``.
    follow_id, _ = seed_epic(repo, title=f"Follow-up of {epic_id}", n_tasks=1)
    follow_path = repo / ".planctl" / "epics" / f"{follow_id}.json"
    follow_def = json.loads(follow_path.read_text(encoding="utf-8"))
    follow_def["depends_on_epics"] = [epic_id]
    follow_def["created_by_close_of"] = epic_id
    follow_path.write_text(json.dumps(follow_def), encoding="utf-8")
    # A stale followup.yaml is also on disk; the adopt path must NOT re-scaffold.
    _seed_followup_yaml(repo, epic_id, epic_id, n_tasks=1)

    r = _finalize(epic_id)
    assert r.exit_code == 0, r.output
    env = _envelope(r.output)
    assert env["outcome"] == "closed_with_followup"
    assert env["new_epic_id"] == follow_id
    assert _epic_status(repo, epic_id) == "done"


# ---------------------------------------------------------------------------
# Outcome: partial_followup (wired but under-provisioned)
# ---------------------------------------------------------------------------


def test_partial_followup_stops_without_close(planctl_git_repo):
    repo = planctl_git_repo
    epic_id, task_ids = seed_epic(repo, title="Partial", n_tasks=1)
    _mark_all_done(repo, task_ids)
    h = _empty_set_hash()
    _seed_brief(repo, epic_id, h)
    # Two distinct kept ordinals → expected 2 follow-up tasks.
    _seed_verdict(
        repo,
        epic_id,
        commit_set_hash=h,
        decisions=[
            {"fid": "f1", "action": "kept", "task": 1, "rationale": "a"},
            {"fid": "f2", "action": "kept", "task": 2, "rationale": "b"},
        ],
    )
    # A closer-scaffolded follow-up with only 1 task (under-provisioned →
    # partial). Stamped with the close provenance; the count gate, not the
    # stamp, drives the partial verdict.
    follow_id, _ = seed_epic(repo, title=f"Partial follow {epic_id}", n_tasks=1)
    fp = repo / ".planctl" / "epics" / f"{follow_id}.json"
    fd = json.loads(fp.read_text(encoding="utf-8"))
    fd["depends_on_epics"] = [epic_id]
    fd["created_by_close_of"] = epic_id
    fp.write_text(json.dumps(fd), encoding="utf-8")

    r = _finalize(epic_id)
    assert r.exit_code == 0, r.output
    env = _envelope(r.output)
    assert env["outcome"] == "partial_followup"
    assert env["new_epic_id"] == follow_id
    assert env["expected_tasks"] == 2
    assert env["actual_tasks"] == 1
    # No close on a partial follow-up.
    assert _epic_status(repo, epic_id) == "open"


# ---------------------------------------------------------------------------
# Refusals: stale hash, missing verdict, missing followup
# ---------------------------------------------------------------------------


def test_stale_artifacts_refusal(planctl_git_repo):
    repo = planctl_git_repo
    epic_id, task_ids = seed_epic(repo, title="Stale", n_tasks=1)
    _mark_all_done(repo, task_ids)
    fresh = _empty_set_hash()
    _seed_brief(repo, epic_id, fresh)
    # Verdict stamped with a DIFFERENT hash → a commit landed after the audit.
    _seed_verdict(repo, epic_id, commit_set_hash="deadbeef" * 8, decisions=[])

    r = _finalize(epic_id)
    assert r.exit_code == 1, r.output
    env = _envelope(r.output)
    assert env["success"] is False
    assert env["error"]["code"] == "STALE_ARTIFACTS"
    assert env["error"]["details"]["fresh_hash"] == fresh
    # Refuse, never delete: the verdict artifact survives.
    assert verdict_path(repo, epic_id).exists()
    assert _epic_status(repo, epic_id) == "open"


def test_missing_verdict_no_meta_fails_closed(planctl_git_repo):
    """No verdict.json AND no report.meta.json → VERDICT_MISSING (audit never ran)."""
    repo = planctl_git_repo
    epic_id, task_ids = seed_epic(repo, title="No verdict", n_tasks=1)
    _mark_all_done(repo, task_ids)
    _seed_brief(repo, epic_id, _empty_set_hash())
    # No verdict.json, no report.meta.json.

    r = _finalize(epic_id)
    assert r.exit_code == 1, r.output
    env = _envelope(r.output)
    assert env["error"]["code"] == "VERDICT_MISSING"
    assert _epic_status(repo, epic_id) == "open"


def test_zero_findings_no_verdict_closes_clean(planctl_git_repo):
    """No verdict.json but meta.findings==0 → synthesize empty verdict → closed_clean."""
    repo = planctl_git_repo
    epic_id, task_ids = seed_epic(repo, title="Zero findings skip", n_tasks=1)
    _mark_all_done(repo, task_ids)
    h = _empty_set_hash()
    _seed_brief(repo, epic_id, h)
    _seed_report_meta(repo, epic_id, h, findings=0)
    # No verdict.json written — the close-planner was intentionally skipped.

    r = _finalize(epic_id)
    assert r.exit_code == 0, r.output
    env = _envelope(r.output)
    assert env["outcome"] == "closed_clean"
    assert _epic_status(repo, epic_id) == "done"


def test_nonzero_findings_no_verdict_fails_closed(planctl_git_repo):
    """No verdict.json but meta.findings>0 → planner crashed → VERDICT_MISSING."""
    repo = planctl_git_repo
    epic_id, task_ids = seed_epic(repo, title="Planner crashed", n_tasks=1)
    _mark_all_done(repo, task_ids)
    h = _empty_set_hash()
    _seed_brief(repo, epic_id, h)
    _seed_report_meta(repo, epic_id, h, findings=2, risk="Medium")
    # No verdict.json — audit found findings but the planner never ran.

    r = _finalize(epic_id)
    assert r.exit_code == 1, r.output
    env = _envelope(r.output)
    assert env["error"]["code"] == "VERDICT_MISSING"
    assert env["error"]["details"]["audit_findings"] == 2
    assert _epic_status(repo, epic_id) == "open"


def test_missing_followup_fails_closed(planctl_git_repo):
    repo = planctl_git_repo
    epic_id, task_ids = seed_epic(repo, title="No followup yaml", n_tasks=1)
    _mark_all_done(repo, task_ids)
    h = _empty_set_hash()
    _seed_brief(repo, epic_id, h)
    # Surviving decision but NO followup.yaml on disk → fail closed.
    _seed_verdict(
        repo,
        epic_id,
        commit_set_hash=h,
        decisions=[{"fid": "f1", "action": "kept", "task": 1, "rationale": "real"}],
    )

    r = _finalize(epic_id)
    assert r.exit_code == 1, r.output
    env = _envelope(r.output)
    assert env["error"]["code"] == "FOLLOWUP_MISSING"
    assert env["error"]["details"]["expected_tasks"] == 1
    assert _epic_status(repo, epic_id) == "open"


# ---------------------------------------------------------------------------
# Id validation
# ---------------------------------------------------------------------------


def test_bad_epic_id(planctl_git_repo):
    r = _finalize("not-an-id")
    assert r.exit_code == 1, r.output
    assert _envelope(r.output)["error"]["code"] == "BAD_EPIC_ID"


def test_task_shaped_id_points_at_parent(planctl_git_repo):
    r = _finalize("fn-7-demo.3")
    assert r.exit_code == 1, r.output
    env = _envelope(r.output)
    assert env["error"]["code"] == "BAD_EPIC_ID"
    assert env["error"]["details"]["parent_epic"] == "fn-7-demo"


def test_epic_not_found(planctl_git_repo):
    r = _finalize("fn-9999-missing")
    assert r.exit_code == 1, r.output
    assert _envelope(r.output)["error"]["code"] == "EPIC_NOT_FOUND"


# ---------------------------------------------------------------------------
# Exhaustiveness: every CloseOutcome member maps to a /plan:close handler.
# ---------------------------------------------------------------------------


# The set of outcomes the /plan:close coordinator switches on. Mirrors the saga
# in run_close_finalize + the close skill's typed-outcome switch (task .5). This
# test is the standing guard that no outcome ships without a handler.
_CLOSE_SKILL_HANDLERS = {
    "closed_clean",
    "closed_with_followup",
    "fatal_halt",
    "partial_followup",
}


def test_close_outcome_exhaustiveness():
    """Every CloseOutcome member has a /plan:close handler and vice versa."""
    from planctl.run_close_finalize import CloseOutcome

    members = {o.value for o in CloseOutcome}
    assert members == _CLOSE_SKILL_HANDLERS, (
        "CloseOutcome members and close-skill handlers diverged: "
        f"outcomes only={members - _CLOSE_SKILL_HANDLERS}, "
        f"handlers only={_CLOSE_SKILL_HANDLERS - members}"
    )


# ---------------------------------------------------------------------------
# Retired verb: `epic followup-of` is gone
# ---------------------------------------------------------------------------


def test_epic_followup_of_verb_is_gone():
    r = run_cli(["epic", "followup-of", "fn-1-x"])
    assert r.exit_code != 0
    assert "No such command" in r.output or "no such command" in r.output.lower()
