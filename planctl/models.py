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

# fn-592: approval state — top-level field on both epics and tasks. Replaces
# keeper's `approvals` sidecar SQLite table; planctl JSON files are the
# canonical source. Missing field defaults to "pending" (see normalize_epic /
# normalize_task). Validated at every read/write boundary in run_validate.py
# and by the `approve` subcommand's click.Choice. "pending" is the implicit
# default for new epics/tasks; the operator flips it via
# `planctl approve <epic_id> [<task_id>] {approved,rejected,pending}`.
APPROVAL_STATUSES = ("approved", "rejected", "pending")

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
    # fn-488: ``closer_acked_at`` migrated off the tracked epic JSON into
    # the gitignored ``.planctl/state/acks.db`` SQLite store.  Mirrors
    # the ``draft`` pop above — any future load of a pre-fn-488 file
    # (or a half-migrated checkout) gets the stale stamp scrubbed on
    # the next write so the value can never desync the source of truth
    # in acks.db.  Silent — no log, no warn.
    data.pop("closer_acked_at", None)
    # fn-502: ``audited_into`` was a forward pointer from a closed epic
    # to the follow-up created by /plan:audit, written by ``epic close
    # --audited-into``.  The flag has been deleted; the audit skill now
    # threads the follow-up id through ``commit-plan after-audit
    # --followup <eid>`` directly.  Mirrors the ``draft`` and
    # ``closer_acked_at`` pops above — any future load of a pre-fn-502
    # file gets the dead key scrubbed on the next write so it cannot
    # reintroduce itself.  Silent — no log, no warn.
    data.pop("audited_into", None)
    # fn-559: ``auditor_done_at`` was the fn-521 audit-gate stamp written by
    # the standalone ``/plan:audit`` flow (``epic auditor-done`` / close
    # ``--no-audit-required``).  The auditor concept was torn down — the audit
    # now runs INLINE inside ``/plan:close`` before the irreversible close
    # mutation, so there is no separate auditor stamp.  Mirrors the ``draft`` /
    # ``closer_acked_at`` / ``audited_into`` pops above: any future load of a
    # pre-fn-559 file gets the dead key scrubbed on the next write so it cannot
    # reintroduce itself.  Build-forward — no migration, no SCHEMA_VERSION bump.
    # Silent — no log, no warn.
    data.pop("auditor_done_at", None)
    if "branch_name" not in data:
        data["branch_name"] = None
    if "depends_on_epics" not in data:
        data["depends_on_epics"] = []
    if "plan_review_status" not in data:
        data["plan_review_status"] = "unknown"
    if "plan_reviewed_at" not in data:
        data["plan_reviewed_at"] = None
    if "work_review_status" not in data:
        data["work_review_status"] = "unknown"
    if "work_reviewed_at" not in data:
        data["work_reviewed_at"] = None
    if "epic_review_status" not in data:
        data["epic_review_status"] = "unknown"
    if "epic_reviewed_at" not in data:
        data["epic_reviewed_at"] = None
    if "last_validated_at" not in data:
        data["last_validated_at"] = None
    # Multi-repo fields — null on legacy records (no migration, no SCHEMA_VERSION bump).
    if "primary_repo" not in data:
        data["primary_repo"] = None
    if "touched_repos" not in data:
        data["touched_repos"] = None
    # Manual-approval-gate fields (fn-386 + fn-488).  `closer_done_at` is
    # still stamped on the tracked epic JSON when `epic close` lands —
    # the close event is single-source (one human-driven mutation per
    # epic lifetime) and benefits from being committed alongside the
    # other epic fields.  `closer_acked_at` lives in `acks.db` (fn-488)
    # and is merged into the bundle by the plug-side bundle builder;
    # the field is intentionally NOT defaulted here so downstream
    # consumers always source it from acks.db via the merge.  Pre-
    # existing closed epics with `closer_done_at` null are grandfathered
    # (gate doesn't fire).
    if "closer_done_at" not in data:
        data["closer_done_at"] = None
    # Close-provenance field — null on legacy records and on closes that
    # predate this stamp. ``close_reason`` carries the closer's terminal
    # decision: today the only literal that flows downstream is
    # ``"discarded"``, which ``runtime_status.derive_epic_runtime_status``
    # short-circuits as a self-acked terminal state (no human ack-gate
    # needed). Written by ``run_epic_close.run`` at close time.
    # Previously stored alongside an ``audited_into`` forward pointer;
    # removed in fn-502 in favor of explicit ``commit-plan after-audit
    # --followup <eid>`` (see the ``data.pop`` migration above).
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
    # fn-592: approval gate field — top-level on every epic JSON. Missing or
    # null gets the implicit "pending" default; the value is the canonical
    # source for keeper's filter (replaces the `approvals` sidecar).
    # Additive, no SCHEMA_VERSION bump (mirrors `tier`, `snippets`, etc.).
    if data.get("approval") is None:
        data["approval"] = "pending"
    # fn-595: queue_jump signals to keeper that this epic should sort above all
    # other root epics on the board (via a `!`-prefixed sort_path).
    # The signal is server-derived from the /plan:queue scaffold event — the
    # field rides the planctl_invocation envelope (the canonical seam keeper
    # folds) so a re-fold from event 0 reproduces it deterministically. Missing
    # field defaults to False; mirrors the additive precedents (snippets,
    # bundles, approval) — no SCHEMA_VERSION bump.
    if "queue_jump" not in data:
        data["queue_jump"] = False
    return data


def normalize_task(data: dict) -> dict:
    """Apply defaults for optional task fields."""
    # fn-488: ``worker_acked_at`` migrated off the tracked task JSON
    # into the gitignored ``.planctl/state/acks.db`` SQLite store.
    # Mirrors the ``draft`` pop in ``normalize_epic`` — any future load
    # of a pre-fn-488 file (or a half-migrated checkout) gets the stale
    # stamp scrubbed on the next write so the value can never desync
    # the source of truth in acks.db.  Silent — no log, no warn.
    data.pop("worker_acked_at", None)
    if "priority" not in data:
        data["priority"] = None
    if "depends_on" not in data:
        data["depends_on"] = data.get("deps", [])
    if "work_review_status" not in data:
        data["work_review_status"] = "unknown"
    if "work_reviewed_at" not in data:
        data["work_reviewed_at"] = None
    # Multi-repo field — null on legacy records.
    if "target_repo" not in data:
        data["target_repo"] = None
    # Manual-approval-gate fields (fn-386 + fn-488).  `worker_done_at` is
    # still stamped on the tracked task JSON when `done` lands — the
    # done event is single-source (worker exit) and benefits from being
    # committed alongside the other task fields.  `worker_acked_at`
    # lives in `acks.db` (fn-488) and is merged into the bundle by the
    # plug-side bundle builder; the field is intentionally NOT defaulted
    # here so downstream consumers always source it from acks.db via
    # the merge.  Pre-existing done tasks with `worker_done_at` null
    # are grandfathered (gate doesn't fire).
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
    # fn-592: approval gate field — top-level on every task JSON. Missing or
    # null gets the implicit "pending" default; mirrors normalize_epic above
    # so every consumer treats absence as pending uniformly.
    if data.get("approval") is None:
        data["approval"] = "pending"
    return data


def merge_task_state(definition: dict, runtime: dict | None) -> dict:
    """Merge task definition with runtime state.

    If runtime is None, default to {"status": "todo"}.
    Runtime fields overwrite definition fields.
    """
    if runtime is None:
        runtime = {"status": "todo"}
    merged = {**definition, **runtime}
    return normalize_task(merged)


def task_priority(task_data: dict) -> int:
    """Priority for sorting (None -> 999)."""
    try:
        if task_data.get("priority") is None:
            return 999
        return int(task_data["priority"])
    except Exception:
        return 999
