"""planctl audit submit - persist the quality-auditor's report markdown.

The content-blind quality-auditor reads ``BRIEF_REF``, writes its findings as a
markdown report, and pipes it to ``planctl audit submit <epic_id> --file -
--findings <N> --risk <Low|Medium|High>``. This verb stamps the report with the
brief's ``commit_set_hash`` + ``schema_version`` (so ``close-finalize`` can
later refuse on a stale commit set), persists the markdown commit-free under
``audits/<epic_id>/report.md`` plus a small ``report.meta.json`` sidecar
(version, hash, findings count, risk), and returns a content-blind envelope
echoing the handle + the findings/risk flags.

Runtime-state-only (like ``claim`` / ``close-preflight``): mutates only
gitignored ``state/audits/`` and draws NO ``.planctl/`` commit. Last-writer-wins
— a re-submit overwrites the prior report + meta atomically.

Typed errors: ``BAD_EPIC_ID``, ``NOT_A_PROJECT``, ``BRIEF_MISSING`` (run
``close-preflight`` first), ``BRIEF_CORRUPT``, ``NO_STDIN`` / ``PAYLOAD_TOO_LARGE``
/ ``BAD_ENCODING`` (stdin read), ``BAD_RISK`` (risk flag not in the enum).
"""

from __future__ import annotations

import json
from types import SimpleNamespace

#: Accepted ``--risk`` values, mirroring the auditor's three-level risk label.
_RISK_LEVELS = ("Low", "Medium", "High")


def run(args: SimpleNamespace) -> int:
    from planctl.audit_artifacts import (
        AUDIT_SCHEMA_VERSION,
        report_path,
        write_artifact,
    )
    from planctl.output import emit
    from planctl.submit_common import (
        emit_submit_error,
        read_payload_capped,
        resolve_audit_context,
    )

    epic_id: str = args.epic_id
    project: str | None = getattr(args, "project", None)
    file_arg: str = getattr(args, "file", "-")
    findings: int = getattr(args, "findings", 0)
    risk: str = getattr(args, "risk", "")

    if risk not in _RISK_LEVELS:
        emit_submit_error(
            "BAD_RISK",
            f"--risk must be one of {', '.join(_RISK_LEVELS)}; got {risk!r}",
        )

    primary_repo, brief = resolve_audit_context(epic_id, project)
    report_md = read_payload_capped(file_arg, label="audit report")

    commit_set_hash = brief.get("commit_set_hash")

    report_dest = report_path(primary_repo, epic_id)
    write_artifact(report_dest, report_md)

    # The meta sidecar carries the stamped hash + the echoed flags so a reader
    # (close-finalize) gets the report's provenance without re-parsing markdown.
    meta = {
        "schema_version": AUDIT_SCHEMA_VERSION,
        "epic_id": epic_id,
        "commit_set_hash": commit_set_hash,
        "findings": findings,
        "risk": risk,
    }
    meta_dest = report_dest.with_name(report_dest.stem + ".meta.json")
    write_artifact(meta_dest, json.dumps(meta, indent=2, sort_keys=True) + "\n")

    emit(
        {
            "report_ref": str(report_dest),
            "meta_ref": str(meta_dest),
            "commit_set_hash": commit_set_hash,
            "findings": findings,
            "risk": risk,
        }
    )
    return 0
