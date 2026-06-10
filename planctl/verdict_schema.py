"""Close-phase verdict schema + reject-envelope builder for the submit verbs.

The close-planner emits this verdict and ``planctl verdict submit`` validates
it at emission. The verdict is the structured record of what the audit decided
per finding:

    {
      "fatal": bool,
      "fatal_reason": str,
      "decisions": [
        {"fid": str, "action": "kept"|"culled"|"merged-into-<fid>",
         "task": int|null, "rationale": str},
        ...
      ]
    }

``additionalProperties: false`` on every object node keeps the wire shape tight.
The submit verb runs :data:`VERDICT_SCHEMA` (jsonschema, structural) THEN
:func:`cross_field_errors` (the invariants jsonschema cannot express:
merged-into targets reference a real fid; culled ⇒ ``task`` null; kept/merged ⇒
non-null ordinal; ``fatal: true`` ⇒ non-empty ``fatal_reason``).

The reject UX is deliberately minimal (per the practice-scout reask guidance): a
machine-readable error list (loc/type/msg), the TOP-3 errors only, and the
minimal schema fragment for the single offending path — never the whole schema
in a retry prompt. Too much schema in the error makes agent self-correction
worse, not better. :func:`build_reject_envelope` assembles that shape.
"""

from __future__ import annotations

import re
from typing import Any

#: ``merged-into-<fid>`` action prefix. A ``kept`` or ``culled`` action is a
#: bare literal; a merge is the prefix followed by the target finding id.
_MERGED_INTO_PREFIX = "merged-into-"

#: The small verdict JSON schema (Draft 2020-12). Every object node pins
#: ``additionalProperties: false``. The ``action`` enum is open-ended on the
#: merge variant (any ``merged-into-<fid>`` string), so the schema constrains it
#: with a regex pattern and :func:`cross_field_errors` does the fid-existence
#: cross-check the pattern cannot.
VERDICT_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "additionalProperties": False,
    "required": ["fatal", "fatal_reason", "decisions"],
    "properties": {
        "fatal": {"type": "boolean"},
        "fatal_reason": {"type": "string"},
        "decisions": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["fid", "action", "task", "rationale"],
                "properties": {
                    "fid": {"type": "string", "minLength": 1},
                    "action": {
                        "type": "string",
                        # `kept`, `culled`, or `merged-into-<non-empty fid>`.
                        "pattern": r"^(kept|culled|merged-into-.+)$",
                    },
                    # int ordinal or explicit null — never a float / string.
                    "task": {"type": ["integer", "null"]},
                    "rationale": {"type": "string", "minLength": 1},
                },
            },
        },
    },
}

_ACTION_RE = re.compile(r"^(kept|culled|merged-into-.+)$")


def _merge_target(action: str) -> str | None:
    """Return the target fid of a ``merged-into-<fid>`` action, else ``None``."""
    if action.startswith(_MERGED_INTO_PREFIX):
        return action[len(_MERGED_INTO_PREFIX) :]
    return None


def cross_field_errors(verdict: dict[str, Any]) -> list[dict[str, Any]]:
    """Cross-field invariants jsonschema cannot express, as machine-readable rows.

    Assumes *verdict* already passed :data:`VERDICT_SCHEMA` structurally (the
    caller runs the structural pass first and short-circuits on its errors).
    Each returned row matches the structural-error row shape
    (``{loc, type, msg}``) so :func:`build_reject_envelope` treats both
    uniformly.

    Invariants:

    * ``fatal: true`` ⇒ non-empty ``fatal_reason`` (a fatal verdict must say why).
    * every ``merged-into-<fid>`` target references an EXISTING decision ``fid``
      (no dangling merge).
    * ``culled`` ⇒ ``task`` is ``null`` (a culled finding spawns no follow-up).
    * ``kept`` / ``merged-into-*`` ⇒ ``task`` is a non-null integer ordinal
      (the follow-up task this finding lands in).
    """
    errors: list[dict[str, Any]] = []

    fatal = verdict.get("fatal")
    fatal_reason = verdict.get("fatal_reason", "")
    if fatal is True and not (isinstance(fatal_reason, str) and fatal_reason.strip()):
        errors.append(
            {
                "loc": "fatal_reason",
                "type": "fatal_reason_required",
                "msg": "fatal: true requires a non-empty fatal_reason",
            }
        )

    decisions = verdict.get("decisions", [])
    known_fids = {
        d.get("fid")
        for d in decisions
        if isinstance(d, dict) and isinstance(d.get("fid"), str)
    }

    for idx, decision in enumerate(decisions):
        if not isinstance(decision, dict):
            continue  # structural pass already flagged this
        action = decision.get("action", "")
        task = decision.get("task")
        loc_base = f"decisions[{idx}]"

        target = _merge_target(action) if isinstance(action, str) else None
        if target is not None and target not in known_fids:
            errors.append(
                {
                    "loc": f"{loc_base}.action",
                    "type": "dangling_merge_target",
                    "msg": (
                        f"merged-into target fid {target!r} does not match any "
                        "decision fid in this verdict"
                    ),
                }
            )

        if action == "culled":
            if task is not None:
                errors.append(
                    {
                        "loc": f"{loc_base}.task",
                        "type": "culled_task_not_null",
                        "msg": "a culled decision must have task: null",
                    }
                )
        elif action == "kept" or target is not None:
            # kept or a (well-formed) merge ⇒ a real follow-up ordinal.
            if not isinstance(task, int) or isinstance(task, bool):
                errors.append(
                    {
                        "loc": f"{loc_base}.task",
                        "type": "task_ordinal_required",
                        "msg": (
                            f"a {action!r} decision must carry a non-null integer "
                            "task ordinal"
                        ),
                    }
                )

    return errors


def _schema_fragment_for_loc(loc: str) -> dict[str, Any]:
    """Return the minimal schema fragment governing the offending *loc*.

    Walks :data:`VERDICT_SCHEMA` to the narrowest sub-schema for the dotted /
    indexed path (e.g. ``decisions[2].action`` → the ``action`` property
    schema). On any miss, returns the top-level required/property skeleton so the
    retry prompt always has SOME anchor — but never the full nested schema.
    """
    # Top-level field (no dot, no index) → that property's schema.
    head = re.split(r"[.\[]", loc, maxsplit=1)[0]
    props = VERDICT_SCHEMA.get("properties", {})

    # A decisions[...] path drills into the item schema's property.
    m = re.match(r"^decisions(?:\[\d+\])?(?:\.(\w+))?$", loc)
    if m:
        item_schema = props.get("decisions", {}).get("items", {})
        sub = m.group(1)
        if sub is not None:
            frag = item_schema.get("properties", {}).get(sub)
            if frag is not None:
                return {sub: frag}
        # Bare decisions / decisions[i] → the item required+props skeleton.
        return {
            "required": item_schema.get("required", []),
            "properties": item_schema.get("properties", {}),
        }

    if head in props:
        return {head: props[head]}

    # Fallback anchor: top-level skeleton (required keys + their bare types).
    return {
        "required": VERDICT_SCHEMA.get("required", []),
        "properties": {
            k: {"type": v.get("type")} for k, v in props.items() if "type" in v
        },
    }


def build_reject_envelope(errors: list[dict[str, Any]]) -> dict[str, Any]:
    """Assemble the typed verdict-reject envelope from a machine-readable list.

    *errors* is the combined list of structural + cross-field rows, each a
    ``{loc, type, msg}`` dict. The envelope surfaces the TOP-3 errors and the
    minimal schema fragment for the FIRST error's path only — never the full
    schema (per the reask practice-scout note: over-much schema in a retry
    prompt degrades self-correction). ``error_count`` reports the true total so
    the agent knows the list was truncated.

    Shape::

        {"success": false,
         "error": {"code": "VERDICT_INVALID",
                   "message": "...",
                   "details": {"errors": [<=3 rows], "error_count": N,
                               "schema_fragment": {...}}}}
    """
    top = errors[:3]
    first_loc = errors[0]["loc"] if errors else ""
    return {
        "success": False,
        "error": {
            "code": "VERDICT_INVALID",
            "message": (
                f"verdict failed validation ({len(errors)} error(s)); "
                "fix the listed paths and resubmit"
            ),
            "details": {
                "errors": top,
                "error_count": len(errors),
                "schema_fragment": _schema_fragment_for_loc(first_loc),
            },
        },
    }


def schema_errors(verdict: Any) -> list[dict[str, Any]]:
    """Run the structural :data:`VERDICT_SCHEMA` pass, returning machine rows.

    Each ``jsonschema`` ``ValidationError`` is flattened to the ``{loc, type,
    msg}`` row shape: ``loc`` is the dotted/indexed JSON path
    (``decisions[2].action``), ``type`` is the failing validator keyword
    (``required`` / ``type`` / ``pattern`` / ``additionalProperties``), ``msg``
    is jsonschema's human message. Empty list ⇒ structurally valid.
    """
    from jsonschema import Draft202012Validator

    validator = Draft202012Validator(VERDICT_SCHEMA)
    rows: list[dict[str, Any]] = []
    for err in validator.iter_errors(verdict):
        # Build a dotted/indexed path from the absolute_path deque.
        loc_parts: list[str] = []
        for part in err.absolute_path:
            if isinstance(part, int):
                loc_parts.append(f"[{part}]")
            else:
                loc_parts.append(f".{part}" if loc_parts else str(part))
        loc = "".join(loc_parts) or "<root>"
        rows.append({"loc": loc, "type": err.validator, "msg": err.message})
    return rows


__all__ = (
    "VERDICT_SCHEMA",
    "cross_field_errors",
    "schema_errors",
    "build_reject_envelope",
)
