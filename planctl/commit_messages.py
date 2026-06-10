"""Centralized commit message templates for planctl CLI mutations.

Every mutating verb maps to a callable ``(target_id, detail) -> subject_str``.
Subject format: ``chore(planctl): <verb> <id>[ — <detail>]``
Em-dash is the literal — character (U+2014).

The hookctl ``planctl-mutation`` post-hook appends the three trailers after the subject:
    Planctl-Op: <verb>
    Planctl-Target: <id>
    Planctl-Prev-Op: <sha captured before git commit>

Read-only verbs (show, cat, list, etc.) are NOT registered here — they use
``build_planctl_invocation_readonly`` which produces a NULL subject/files
payload; the hook INSERTs a row and emits UDS but skips the git commit.
"""

from __future__ import annotations

from collections.abc import Callable


def _subject(verb: str, target_id: str, detail: str | None) -> str:
    """Build a chore(planctl) subject line."""
    if detail:
        # Strip control characters and newlines from detail
        safe_detail = detail.replace("\n", " ").replace("\r", " ").strip()
        return f"chore(planctl): {verb} {target_id} \u2014 {safe_detail}"
    return f"chore(planctl): {verb} {target_id}"


# Map from CLI verb name -> subject builder callable
# Key is the canonical verb name passed to build_subject()
VERB_TEMPLATES: dict[str, Callable[[str, str | None], str]] = {
    # Epic verbs
    "create": lambda t, d: _subject("create", t, d),
    "refine": lambda t, d: _subject("refine", t, d),
    "close": lambda t, d: _subject("close", t, d),
    # Sanctioned delete verb — unlinks every artifact (epic JSON,
    # task JSONs, epic + task spec markdowns, state, locks) and rides one
    # commit covering the whole pathspec. Companion to `close` (which only
    # stamps `closer_done_at`); not in VALIDATION_RESTAMP_VERBS because the
    # epic ceases to exist after `rm`.
    "rm": lambda t, d: _subject("rm", t, d),
    "publish": lambda t, d: _subject("publish", t, d),
    "add-dep": lambda t, d: _subject("add-dep", t, d),
    # Batch epic-dep wirer — distinct key from single-edge `add-dep`.
    "add-deps": lambda t, d: _subject("add-deps", t, d),
    "rm-dep": lambda t, d: _subject("rm-dep", t, d),
    "set-branch": lambda t, d: _subject("set-branch", t, d),
    "set-title": lambda t, d: _subject("set-title", t, d),
    # Task verbs
    # There is no `task-create` / `set-spec` / `set-deps` (nor a `dep-add` dep
    # verb) — the create/rewrite paths ride `scaffold` / `refine-apply`.
    "set-description": lambda t, d: _subject("set-description", t, d),
    "set-acceptance": lambda t, d: _subject("set-acceptance", t, d),
    "reset": lambda t, d: _subject("reset", t, d),
    "claim": lambda t, d: _subject("claim", t, d),
    "block": lambda t, d: _subject("block", t, d),
    "done": lambda t, d: _subject("done", t, d),
    # Multi-repo structural verbs
    "set-primary-repo": lambda t, d: _subject("set-primary-repo", t, d),
    "set-touched-repos": lambda t, d: _subject("set-touched-repos", t, d),
    "set-target-repo": lambda t, d: _subject("set-target-repo", t, d),
    # Spec-metadata setters — shared verb name across the task
    # and epic surfaces; both join VALIDATION_RESTAMP_VERBS.
    "set-snippets": lambda t, d: _subject("set-snippets", t, d),
    "set-bundles": lambda t, d: _subject("set-bundles", t, d),
    # Validate verb (mutating only when --epic is given and marker transitions None → ts)
    "validate": lambda t, d: _subject("validate", t, d),
    # Invalidate verb (explicit clear; primary job is the clear, not a side-effect)
    "invalidate": lambda t, d: _subject("invalidate", t, d),
    # Queue-jump verb — priority-flag verb, not structural: flips
    # queue_jump=true post-hoc on an existing epic so keeper sorts it to the
    # front of the board. NOT in VALIDATION_RESTAMP_VERBS (same stance as
    # invalidate/task-set-tier).
    "queue-jump": lambda t, d: _subject("queue-jump", t, d),
    # Project bootstrap — the one mutating verb that builds its own
    # invocation payload directly (explicit fixed file list), without the
    # touched-paths log or CLAUDE_CODE_SESSION_ID. NOT in
    # VALIDATION_RESTAMP_VERBS — it mints no epic. Target is the project name.
    "init": lambda t, d: _subject("init", t, d),
    # Whole-tree epic scaffold — materializes an epic + N tasks
    # + cross-task deps + specs from one YAML in a single transactional
    # call. Target is the freshly-allocated epic id; the per-task writes
    # ride into the same touched-paths session so one envelope/commit
    # covers the whole tree. NOT in VALIDATION_RESTAMP_VERBS — scaffold
    # only ever mints a fresh epic whose last_validated_at already
    # defaults to None via normalize_epic.
    "scaffold": lambda t, d: _subject("scaffold", t, d),
    # Whole-tree refine delta — applies adds + spec-rewrites +
    # dep-rewires + epic-spec rewrite to an EXISTING epic in one transactional
    # call. Target is the epic id. Unlike `scaffold`, refine-apply rewrites an
    # existing tree, so it IS in VALIDATION_RESTAMP_VERBS (re-clears the marker).
    "refine-apply": lambda t, d: _subject("refine-apply", t, d),
    # refine-context --invalidate — conditionally
    # mutating sibling of refine-context's read-only fetch path. Mirrors
    # validate --epic's precedent: when --invalidate is set, the runner
    # writes last_validated_at = None and lands a single commit; without the
    # flag the fetch is read-only and this entry is never reached.
    "refine-context": lambda t, d: _subject("refine-context", t, d),
    # Worker reasoning-tier persistence — runtime detail, not in
    # VALIDATION_RESTAMP_VERBS.
    "task-set-tier": lambda t, d: _subject("task-set-tier", t, d),
}


def build_subject(verb: str, target_id: str, detail: str | None = None) -> str:
    """Return the commit subject for a mutating verb.

    Raises KeyError if the verb is not registered (runtime-only verbs are not
    registered and should never reach this function).
    """
    builder = VERB_TEMPLATES[verb]
    return builder(target_id, detail)
