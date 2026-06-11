"""Constants and data normalization functions."""

from __future__ import annotations

SCHEMA_VERSION = 1

RUNTIME_FIELDS = {
    "status",
    "updated_at",
    "claimed_at",
    "assignee",
    "claim_note",
    "evidence",
    "blocked_reason",
}

TASK_SPEC_HEADINGS = [
    "## Description",
    "## Acceptance",
    "## Done summary",
    "## Evidence",
]

EPIC_STATUSES = ["open", "done"]
TASK_STATUSES = ["todo", "in_progress", "blocked", "done"]

TASK_TIERS = ("medium", "high", "xhigh", "max")


def worker_agent_for_tier(tier: str | None) -> str | None:
    """Map a task tier to the ``plan`` plugin's worker-agent name.

    Returns ``f"plan:worker-{tier}"`` for a ``TASK_TIERS`` member, ``None`` when
    ``tier is None`` (records that never carried a tier), and
    raises ``ValueError`` for a non-null string that is not a ``TASK_TIERS``
    member (corrupt-on-disk guard). The ``None`` return is load-bearing: the
    ``/plan:work`` skill branches on it to surface a clean typed stop rather
    than spawning a ``plan:worker-None`` agent.
    """
    if tier is None:
        return None
    if tier not in TASK_TIERS:
        raise ValueError(f"unknown tier {tier!r}; expected one of {TASK_TIERS} or None")
    return f"plan:worker-{tier}"


def normalize_epic(data: dict) -> dict:
    """Apply defaults for optional epic fields."""
    # Defensive strip of dead keys: ``draft``, ``audited_into``, and
    # ``auditor_done_at`` are not part of the epic schema. The pops keep any
    # on-disk file that still carries one from reintroducing it on the next
    # write — the dead key is scrubbed silently (no log, no warn). The audit
    # now runs INLINE inside ``/plan:close`` before the irreversible close
    # mutation, so there is no separate auditor stamp.
    data.pop("draft", None)
    data.pop("audited_into", None)
    data.pop("auditor_done_at", None)
    if "branch_name" not in data:
        data["branch_name"] = "main"
    if "depends_on_epics" not in data:
        data["depends_on_epics"] = []
    if "last_validated_at" not in data:
        data["last_validated_at"] = None
    # Multi-repo fields — null on legacy records (no migration, no SCHEMA_VERSION bump).
    if "primary_repo" not in data:
        data["primary_repo"] = None
    if "touched_repos" not in data:
        data["touched_repos"] = None
    # `closer_done_at` is stamped on the tracked epic JSON when `epic close`
    # lands — the close event is single-source (one human-driven mutation per
    # epic lifetime) and is committed alongside the other epic fields. It is
    # the completion signal keeper folds: an epic with `closer_done_at` set is
    # done. Legacy records with `closer_done_at` null load fine; the field
    # defaults to None.
    if "closer_done_at" not in data:
        data["closer_done_at"] = None
    # Close-provenance field — null on legacy records and on closes that
    # predate this stamp. ``close_reason`` carries the closer's terminal
    # decision: the only literal that flows downstream is ``"discarded"``,
    # which ``runtime_status.derive_epic_runtime_status`` short-circuits as a
    # terminal complete state (a discarded epic clears its downstream dep gate
    # immediately, even with no tasks). Written by ``run_epic_close.run`` at
    # close time.
    if "close_reason" not in data:
        data["close_reason"] = None
    # Snippet-substrate metadata. Additive list fields, no SCHEMA_VERSION bump
    # (matches the additive list defaults — e.g. depends_on_epics,
    # touched_repos). Order matters in the lists (first-occurrence preservation
    # per the runtime-substrate design); promptctl render-spec handles dedup at
    # union time.
    if "snippets" not in data:
        data["snippets"] = []
    if "bundles" not in data:
        data["bundles"] = []
    # queue_jump signals to keeper that this epic should sort above all
    # other root epics on the board (via a `!`-prefixed sort_path).
    # The signal is server-derived from a scaffold YAML opt-in (`queue_jump:
    # true`) or the `epic queue-jump` verb (`/plan:next`) — the
    # field rides the planctl_invocation envelope (the canonical seam keeper
    # folds) so a re-fold from event 0 reproduces it deterministically. Missing
    # field defaults to False; mirrors the additive precedents (snippets,
    # bundles) — no SCHEMA_VERSION bump.
    if "queue_jump" not in data:
        data["queue_jump"] = False
    # Positive close provenance. When a /plan:close saga scaffolds a
    # follow-up epic for surviving audit findings, the scaffold step stamps the
    # source epic id here. ``close-finalize._find_followup_epic`` discovers the
    # follow-up by exact equality on this stamp — never by ``depends_on_epics``
    # membership, which falsely matches human-planned epics that legitimately
    # depend on the source. The field is immutable after mint; an open epic
    # without the stamp is never adopted (no dep-edge fallback). Missing field
    # defaults to None; mirrors the additive precedents (queue_jump, close_reason)
    # — no SCHEMA_VERSION bump.
    if "created_by_close_of" not in data:
        data["created_by_close_of"] = None
    return data


def normalize_task(data: dict) -> dict:
    """Apply defaults for optional task fields."""
    if "priority" not in data:
        data["priority"] = None
    if "depends_on" not in data:
        data["depends_on"] = data.get("deps", [])
    # Multi-repo field — null on legacy records.
    if "target_repo" not in data:
        data["target_repo"] = None
    # `worker_done_at` is stamped on the tracked task JSON when `done` lands —
    # the done event is single-source (worker exit) and is committed alongside
    # the other task fields. It is the completion signal keeper folds (a task
    # with `worker_done_at` set is done). Legacy records with `worker_done_at`
    # null load fine; the field defaults to None.
    if "worker_done_at" not in data:
        data["worker_done_at"] = None
    # Worker reasoning-tier persistence. LOAD-TIME default only — this None
    # default is the on-disk read path for records that carry no `tier`. The
    # YAML input verbs (`scaffold`, `refine-apply`) reject missing `tier:`
    # upstream with `tier_invalid`, so freshly-minted records always carry
    # a TASK_TIERS member. Records with null `tier` still load so `show` /
    # `claim` / `resolve-task` can surface them; the worker launcher fails
    # loud on null at run time and the human remediates via
    # `/plan:plan <epic_id>` refine.
    if "tier" not in data:
        data["tier"] = None
    # Snippet-substrate metadata. Additive list fields, no
    # SCHEMA_VERSION bump (mirrors normalize_epic above). Order matters
    # in the lists (first-occurrence preservation per the runtime-substrate
    # design); promptctl render-spec handles dedup at union time.
    if "snippets" not in data:
        data["snippets"] = []
    if "bundles" not in data:
        data["bundles"] = []
    return data


def merge_task_state(definition: dict, runtime: dict | None) -> dict:
    """Merge task definition with its runtime sidecar.

    If runtime is None, default to {"status": "todo"}. Runtime fields from the
    gitignored sidecar (``.planctl/state/tasks/<id>.state.json``) overwrite
    definition fields, so the merged dict carries the live ``status`` (and the
    other runtime overlay fields) on top of the committed def.
    """
    if runtime is None:
        runtime = {"status": "todo"}
    merged = {**definition, **runtime}
    normalize_task(merged)
    return merged


def merge_epic_state(definition: dict, epic_runtime: dict | None) -> dict:
    """Merge an epic definition with its runtime sidecar.

    Epics have no ``status`` overlay, so the sidecar carries no runtime field
    that shadows the committed def today. ``epic_runtime`` is ``None`` when no
    sidecar exists; the merge is then a normalize pass over the def. The
    call-shape is kept symmetric with ``merge_task_state`` so the load path is
    uniform across both surfaces.
    """
    runtime = epic_runtime or {}
    merged = {**definition, **runtime}
    normalize_epic(merged)
    return merged


def task_priority(task_data: dict) -> int:
    """Priority for sorting (None -> 999)."""
    try:
        if task_data.get("priority") is None:
            return 999
        return int(task_data["priority"])
    except Exception:
        return 999
