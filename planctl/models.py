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

# fn-586: dormant infrastructure for codex-backed worker subagents. The field
# is additive on every task JSON but nothing reads it today — no setter verb,
# no `/plan:work` routing, no `planctl show` surface. The allowlist is
# {None, "claude", "codex"}; empty string is rejected by `validate` as
# distinct from None. Future routing epic will wire selection.
TASK_BACKENDS = ("claude", "codex")


def normalize_epic(data: dict) -> dict:
    """Apply defaults for optional epic fields."""
    # fn-463: defensive strip of the retired ``draft`` field. The concept was
    # removed in fn-451; the on-disk migration ran in fn-463. The pop stays
    # here so any future load of a not-yet-rewritten file (e.g. a fresh git
    # checkout that hasn't run the scrub) cannot reintroduce the dead key.
    # Silent on purpose — no log, no warn.
    data.pop("draft", None)
    # fn-502: ``audited_into`` was a forward pointer from a closed epic
    # to the follow-up created by /plan:audit, written by ``epic close
    # --audited-into``.  The flag has been deleted; the audit skill now
    # threads the follow-up id through ``commit-plan after-audit
    # --followup <eid>`` directly.  Mirrors the ``draft`` pop above — any
    # future load of a pre-fn-502 file gets the dead key scrubbed on the
    # next write so it cannot reintroduce itself.  Silent — no log, no warn.
    data.pop("audited_into", None)
    # fn-559: ``auditor_done_at`` was the fn-521 audit-gate stamp written by
    # the standalone ``/plan:audit`` flow (``epic auditor-done`` / close
    # ``--no-audit-required``).  The auditor concept was torn down — the audit
    # now runs INLINE inside ``/plan:close`` before the irreversible close
    # mutation, so there is no separate auditor stamp.  Mirrors the ``draft`` /
    # ``audited_into`` pops above: any future load of a pre-fn-559 file gets the
    # dead key scrubbed on the next write so it cannot reintroduce itself.
    # Build-forward — no migration, no SCHEMA_VERSION bump.  Silent.
    data.pop("auditor_done_at", None)
    if "branch_name" not in data:
        data["branch_name"] = None
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
    # fn-513: snippet-substrate metadata. Additive list fields, no
    # SCHEMA_VERSION bump (matches repo precedent for additive list defaults
    # — e.g. depends_on_epics, touched_repos). Order matters in the lists
    # (first-occurrence preservation per the runtime-substrate design);
    # promptctl render-spec handles dedup at union time.
    if "snippets" not in data:
        data["snippets"] = []
    if "bundles" not in data:
        data["bundles"] = []
    # fn-595: queue_jump signals to keeper that this epic should sort above all
    # other root epics on the board (via a `!`-prefixed sort_path).
    # The signal is server-derived from a scaffold YAML opt-in (`queue_jump:
    # true`) or the `epic queue-jump` verb (`/plan:next`) — the
    # field rides the planctl_invocation envelope (the canonical seam keeper
    # folds) so a re-fold from event 0 reproduces it deterministically. Missing
    # field defaults to False; mirrors the additive precedents (snippets,
    # bundles) — no SCHEMA_VERSION bump.
    if "queue_jump" not in data:
        data["queue_jump"] = False
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
    # Worker reasoning-tier persistence (fn-405). LOAD-TIME default only —
    # this None default is purely the legacy-on-disk read path for records
    # written before fn-594 made `tier` required at mint time. The YAML
    # input verbs (`scaffold`, `refine-apply`) now reject missing `tier:`
    # upstream with `tier_invalid`, so freshly-minted records always carry
    # a TASK_TIERS member. Pre-fn-594 records with null `tier` still load
    # so `show` / `claim` / `resolve-task` can surface them; the worker
    # launcher fails loud on null at run time and the human remediates
    # via `/plan:plan <epic_id>` refine (build-forward).
    if "tier" not in data:
        data["tier"] = None
    # fn-586: dormant infrastructure for codex-backed worker subagents.
    # Additive null-defaulted field, no SCHEMA_VERSION bump (mirrors `tier`
    # above and the `snippets` / `primary_repo` additive precedents).
    # Allowlist enforced in `run_validate.py`: {None, "claude", "codex"};
    # empty string is rejected distinctly from None. No setter verb today,
    # no `/plan:work` routing reads this field, no `planctl show` surface.
    # Future maintainers grepping for `preferred_backend`: the routing epic
    # owns selection — this stub only carries the schema slot.
    if "preferred_backend" not in data:
        data["preferred_backend"] = None
    # fn-513: snippet-substrate metadata. Additive list fields, no
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
