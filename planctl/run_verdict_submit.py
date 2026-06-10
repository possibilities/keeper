"""planctl verdict submit - validate + persist the close-planner's verdict JSON.

The close-planner reads the auditor's report, decides per-finding (keep / cull /
merge), and pipes a small verdict JSON to ``planctl verdict submit <epic_id>
--file -``:

    {"fatal": bool, "fatal_reason": str,
     "decisions": [{"fid", "action", "task", "rationale"}, ...]}

This verb validates the payload at emission — structural (``VERDICT_SCHEMA``,
jsonschema, ``additionalProperties: false`` on every node) THEN the cross-field
invariants jsonschema cannot express (merged-into targets reference a real fid;
``culled`` ⇒ ``task`` null; ``kept`` / ``merged`` ⇒ a non-null ordinal;
``fatal: true`` ⇒ non-empty reason). A reject surfaces the typed, MINIMAL
envelope (top-3 errors + the schema fragment for the first failing path only —
never the whole schema). On success it stamps the brief's ``commit_set_hash`` +
``schema_version`` into the persisted record and writes it commit-free under
``audits/<epic_id>/verdict.json``.

Runtime-state-only (like ``claim``): no ``.planctl/`` commit. Last-writer-wins.

The persisted record stamps ``schema_version`` + ``commit_set_hash`` ALONGSIDE
the submitted top-level keys; the schema rejects unknown top-level keys, so the
stamp is folded in AFTER validation (the validated payload is the wire-shape
subset, the persisted record is that plus provenance).

Typed errors: ``BAD_EPIC_ID``, ``NOT_A_PROJECT``, ``BRIEF_MISSING``,
``BRIEF_CORRUPT``, ``NO_STDIN`` / ``PAYLOAD_TOO_LARGE`` / ``BAD_ENCODING``,
``BAD_JSON`` (unparseable), ``VERDICT_INVALID`` (schema / cross-field — carries
the minimal reject details).
"""

from __future__ import annotations

import json
import sys
from types import SimpleNamespace


def run(args: SimpleNamespace) -> int:
    from planctl._util import format_output
    from planctl.audit_artifacts import (
        AUDIT_SCHEMA_VERSION,
        verdict_path,
        write_artifact,
    )
    from planctl.output import emit
    from planctl.submit_common import (
        emit_submit_error,
        read_payload_capped,
        resolve_audit_context,
        set_invocation_sentinel,
    )
    from planctl.verdict_schema import (
        build_reject_envelope,
        cross_field_errors,
        schema_errors,
    )

    epic_id: str = args.epic_id
    project: str | None = getattr(args, "project", None)
    file_arg: str = getattr(args, "file", "-")

    primary_repo, brief = resolve_audit_context(epic_id, project)
    raw = read_payload_capped(file_arg, label="verdict JSON")

    try:
        verdict = json.loads(raw)
    except json.JSONDecodeError as exc:
        emit_submit_error("BAD_JSON", f"verdict is not valid JSON: {exc}")

    # Structural pass first; if it fails the cross-field pass would key-error on
    # the missing/wrong-typed fields, so short-circuit on structural errors.
    errors = schema_errors(verdict)
    if not errors:
        errors = cross_field_errors(verdict)
    if errors:
        format_output(build_reject_envelope(errors))
        set_invocation_sentinel()
        sys.exit(1)

    # Validated. Persist the wire payload PLUS the provenance stamp (the schema
    # rejects unknown top-level keys, so the stamp folds in only post-validation).
    record = {
        "schema_version": AUDIT_SCHEMA_VERSION,
        "commit_set_hash": brief.get("commit_set_hash"),
        **verdict,
    }
    verdict_dest = verdict_path(primary_repo, epic_id)
    write_artifact(verdict_dest, json.dumps(record, indent=2, sort_keys=True) + "\n")

    # Distinct non-null kept/merged ordinals — the expected follow-up cluster
    # count `followup submit` cross-checks against. Echoed for the close-planner.
    expected_clusters = sorted(
        {
            d["task"]
            for d in verdict.get("decisions", [])
            if isinstance(d.get("task"), int) and not isinstance(d.get("task"), bool)
        }
    )

    emit(
        {
            "verdict_ref": str(verdict_dest),
            "commit_set_hash": brief.get("commit_set_hash"),
            "fatal": verdict.get("fatal"),
            "decision_count": len(verdict.get("decisions", [])),
            "expected_clusters": expected_clusters,
        }
    )
    return 0
