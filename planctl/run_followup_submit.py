"""planctl followup submit - validate + persist the close-planner's follow-up plan.

After the verdict lands, the close-planner authors a follow-up epic plan (the
same YAML shape ``planctl scaffold`` consumes) and pipes it to ``planctl
followup submit <epic_id> --file -``. This verb validates the YAML via scaffold's
DRY-RUN semantics — the exact ``assert-all`` half of scaffold's flow
(:func:`planctl.run_scaffold.validate_scaffold_yaml`), reusing scaffold's leaf
checkers and failure-code priority — WITHOUT the mutate phase: it mints nothing,
so it needs no ``CLAUDE_CODE_SESSION_ID`` and never allocates an ``fn-N``. It
then cross-checks the YAML task count against the persisted verdict's distinct
non-null kept/merged ordinals (the expected follow-up cluster count) so a plan
that under/over-provisions tasks for the kept findings is rejected at emission.
On success it persists the YAML commit-free under ``audits/<epic_id>/followup.yaml``
stamped with the brief's hash via a sidecar.

Runtime-state-only (like ``claim``): no ``.planctl/`` commit. Last-writer-wins.
``close-finalize`` (task 3) is the verb that later replays this YAML through the
real ``scaffold`` mint.

Typed errors: ``BAD_EPIC_ID``, ``NOT_A_PROJECT``, ``BRIEF_MISSING``,
``BRIEF_CORRUPT``, ``NO_STDIN`` / ``PAYLOAD_TOO_LARGE`` / ``BAD_ENCODING``,
``VERDICT_MISSING`` (submit the verdict first — the task-count cross-check needs
it), the full scaffold dry-run code set (``bad_yaml`` / ``spec_invalid`` /
``ref_invalid`` / ``dep_invalid`` / ``epic_dep_invalid`` / ``repo_invalid`` /
``tier_invalid`` / ``dep_cycle``) surfaced verbatim, and ``TASK_COUNT_MISMATCH``
(YAML task count != expected cluster count).
"""

from __future__ import annotations

import json
from types import SimpleNamespace


def _expected_cluster_count(verdict: dict) -> int:
    """Distinct non-null kept/merged ordinals in the persisted verdict.

    A ``culled`` decision carries ``task: null`` (spawns no follow-up); ``kept``
    and ``merged-into-*`` carry an integer ordinal. Multiple findings can merge
    into the same ordinal, so DISTINCT ordinals = the number of follow-up tasks
    the plan should provision.
    """
    return len(
        {
            d["task"]
            for d in verdict.get("decisions", [])
            if isinstance(d.get("task"), int) and not isinstance(d.get("task"), bool)
        }
    )


def run(args: SimpleNamespace) -> int:
    from planctl.audit_artifacts import (
        AUDIT_SCHEMA_VERSION,
        followup_path,
        verdict_path,
        write_artifact,
    )
    from planctl.output import emit
    from planctl.run_scaffold import validate_scaffold_yaml
    from planctl.submit_common import (
        emit_submit_error,
        read_payload_capped,
        resolve_audit_context,
    )

    epic_id: str = args.epic_id
    project: str | None = getattr(args, "project", None)
    file_arg: str = getattr(args, "file", "-")

    primary_repo, brief = resolve_audit_context(epic_id, project)

    # The task-count cross-check needs the persisted verdict — submit it first.
    vp = verdict_path(primary_repo, epic_id)
    if not vp.exists():
        emit_submit_error(
            "VERDICT_MISSING",
            (
                f"no verdict for {epic_id} at {vp}; "
                "run `planctl verdict submit` before the follow-up plan"
            ),
            details={"expected": str(vp)},
        )
    try:
        verdict = json.loads(vp.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        emit_submit_error("BRIEF_CORRUPT", f"could not read verdict {vp}: {exc}")

    followup_yaml = read_payload_capped(file_arg, label="follow-up YAML")

    # Scaffold dry-run: the assert-all half, no mint. Reuses scaffold's leaf
    # checkers + exact failure-code priority. Surfaces scaffold's codes verbatim.
    result = validate_scaffold_yaml(
        followup_yaml.encode("utf-8"), file_label="followup"
    )
    if not result.ok:
        emit_submit_error(result.code, result.message, details=result.details)

    expected = _expected_cluster_count(verdict)
    if result.n_tasks != expected:
        emit_submit_error(
            "TASK_COUNT_MISMATCH",
            (
                f"follow-up plan has {result.n_tasks} task(s) but the verdict's "
                f"distinct kept/merged ordinals expect {expected}"
            ),
            details={"actual_tasks": result.n_tasks, "expected_tasks": expected},
        )

    # Validated. Persist the raw YAML + a hash-stamped sidecar (the YAML itself
    # is scaffold's wire shape and carries no provenance slot).
    followup_dest = followup_path(primary_repo, epic_id)
    write_artifact(followup_dest, followup_yaml)
    meta = {
        "schema_version": AUDIT_SCHEMA_VERSION,
        "epic_id": epic_id,
        "commit_set_hash": brief.get("commit_set_hash"),
        "task_count": result.n_tasks,
    }
    meta_dest = followup_dest.with_name(followup_dest.name + ".meta.json")
    write_artifact(meta_dest, json.dumps(meta, indent=2, sort_keys=True) + "\n")

    emit(
        {
            "followup_ref": str(followup_dest),
            "meta_ref": str(meta_dest),
            "commit_set_hash": brief.get("commit_set_hash"),
            "task_count": result.n_tasks,
            "expected_tasks": expected,
        }
    )
    return 0
