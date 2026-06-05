"""
planctl - File-based task tracking for structured development workflows.

Run `planctl --help` for usage.
"""

from __future__ import annotations

import json
import sys
from types import SimpleNamespace

import click

from planctl._util import FormattedGroup, agent_help_option
from planctl.output import INVOCATION_EMITTED_SENTINEL

_NO_TRACK_COMMANDS: frozenset[str] = frozenset(
    {"cat", "validate", "render-approve-context"}
)
"""Verbs that own their stdout contract and must bypass the invocation decorator.

``cat`` emits raw markdown (no JSON wrapper); ``validate`` emits a non-standard
``{"valid": bool, "errors": [...], "warnings": [...]}`` envelope via
``format_output`` directly (not ``output.emit()``); ``render-approve-context``
emits the byte-for-byte marker-bearing markdown contract the ``/plan:approve``
LLM-as-judge cascade matches on.  Appending a trailing NDJSON line to any of
these verbs' stdout breaks the contract.  The trade-off — no tracking row for
these verbs — is accepted because they are workflow-control surfaces, not
state mutators in the audit-trail sense.
"""


class InvocationTrackedGroup(FormattedGroup):
    """FormattedGroup that emits a trailing ``planctl_invocation`` NDJSON line
    on stdout for every subcommand that didn't already emit one via
    ``output.emit(planctl_invocation=...)``.

    Mutating verbs set ``ctx.obj[INVOCATION_EMITTED_SENTINEL]`` inside
    ``output.emit()`` (see ``planctl/output.py``). This class reads the sentinel
    after the verb returns; absence means the verb was read-only and needs the
    decorator emit.
    """

    def invoke(self, ctx: click.Context):  # type: ignore[override]
        # Walk the resolved subcommand ctx to find the leaf command and its
        # target argument (first positional, if any).
        # We wrap the resolved command's invoke to fire the trailing emit.
        cmd_name = ctx.protected_args[0] if ctx.protected_args else None
        if not cmd_name:
            return super().invoke(ctx)

        # Resolve the subcommand object.
        cmd = self.get_command(ctx, cmd_name)
        if cmd is None:
            return super().invoke(ctx)

        # For subgroups (epic, task, worker),
        # let the parent handle — their own contexts will carry the right name.
        if isinstance(cmd, click.Group):
            return super().invoke(ctx)

        # Allow-list: verbs that own their stdout contract skip the decorator
        # entirely (no tracking row emitted — intentional trade-off).
        if cmd_name in _NO_TRACK_COMMANDS:
            return super().invoke(ctx)

        # Patch the subcommand to emit the invocation record before/after.
        original_invoke = cmd.invoke

        def _tracked_invoke(sub_ctx: click.Context):
            # Extract target: first arg positional param value (if any).
            target = _extract_target(sub_ctx)
            verb = sub_ctx.info_name or cmd_name

            # Normal path: invoke first, then check sentinel.
            result = original_invoke(sub_ctx)
            emitted = isinstance(sub_ctx.obj, dict) and sub_ctx.obj.get(
                INVOCATION_EMITTED_SENTINEL
            )
            if not emitted:
                _emit_readonly_invocation(sub_ctx, verb, target)
            return result

        cmd.invoke = _tracked_invoke  # type: ignore[method-assign]
        try:
            return super().invoke(ctx)
        finally:
            cmd.invoke = original_invoke  # type: ignore[method-assign]


_TARGET_ARG_NAMES = frozenset(("id", "task_id", "epic_id", "dep_id"))


def _extract_target(ctx: click.Context) -> str | None:
    """Extract the target ID from a subcommand context's params.

    **Policy (a) — ``fn-`` prefix gate on the fallback branch.**

    1. Canonical-name preference (no value filter): if any ``click.Argument``
       has a ``.name`` in ``_TARGET_ARG_NAMES`` (``id``, ``task_id``,
       ``epic_id``, ``dep_id``), its value is returned immediately.  The
       canonical name is a strong signal that the value is a planctl id, so no
       ``fn-`` shape check is applied here.  Note the asymmetry with the
       fallback branch below.

    2. First-arg fallback (``fn-`` prefix gate): if no canonical-name arg is
       found, the function walks params in order and returns the first
       ``click.Argument`` value that starts with ``"fn-"``.  Values that do
       NOT start with ``"fn-"`` are skipped and ``None`` is returned.

       Rationale: keeper derives ``planctl_epic_id`` / ``planctl_task_id``
       from the envelope ``target`` via its ``parsePlanRef`` (an ``fn-``
       ref shape).  The fallback gate preserves that invariant.  If a
       future verb needs to track a non-``fn-`` id as target, add a
       canonical name for it to ``_TARGET_ARG_NAMES`` instead of broadening
       this fallback.

    Returns ``None`` when no positional arguments are present (e.g. ``list``,
    ``epics``, ``status``) or when all positional arg values fail both checks.
    """
    first_arg_val: str | None = None
    for param in ctx.command.params:
        if not isinstance(param, click.Argument):
            continue
        val = ctx.params.get(param.name or "")
        if not isinstance(val, str):
            continue
        if param.name in _TARGET_ARG_NAMES:
            return val
        if first_arg_val is None and val.startswith("fn-"):
            first_arg_val = val
    return first_arg_val


def _emit_readonly_invocation(
    ctx: click.Context, verb: str, target: str | None
) -> None:
    """Emit a read-only ``planctl_invocation`` envelope on stdout as NDJSON.

    Resolves repo_root from the current project context; falls back gracefully
    when no planctl project is found (e.g. outside a planctl project dir).

    Prints a read-only ``planctl_invocation`` envelope (NULL ``subject`` /
    ``files``) to stdout — the wire keeper reads off ``PostToolUse:Bash``
    stdout. No commit, no DB side effect.
    """
    try:
        from planctl.invocation import build_planctl_invocation_readonly
        from planctl.project import resolve_project

        proj_ctx = resolve_project()
        pc = build_planctl_invocation_readonly(
            verb, target, repo_root=proj_ctx.project_path
        )
        envelope = {"planctl_invocation": pc}
        print(json.dumps(envelope, separators=(",", ":")), flush=True)
    except Exception:
        # Never fail the CLI over a tracing side-effect.
        pass


AGENT_HELP = """\
#### Quick Start

Initialize a project, scaffold an epic tree, and start working:
```
planctl init
planctl scaffold --file plan.yaml   # mints the epic + its tasks in one call
planctl claim fn-1-add-auth.1
planctl done fn-1-add-auth.1 --summary "Chose JWT"
```

#### Output contract

All commands emit JSON by default (stdout). Use ``--format yaml`` for YAML
or ``--format human`` for tree/table text views on listing commands.

Every non-exception verb emits a ``{"success": bool, ...}`` envelope:
- Success: ``{"success": true, <verb-specific fields>}``
- Error: ``{"success": false, "error": "<message>"}`` — also exits 1

Mutating verbs include a ``planctl_invocation`` payload in the envelope so the
hookctl ``planctl-mutation`` hook can parse and commit ``.planctl/`` state.

**Exceptions to the standard envelope:**
- ``planctl validate`` emits ``{"valid": bool, "errors": [...], "warnings": [...]}``
  (no ``success`` key); exits 1 when ``valid: false``
- ``planctl cat`` emits raw markdown to stdout regardless of ``--format``
  (accepts and ignores the flag)

#### --format positions

Both invocation forms are equivalent:
```
planctl --format yaml epics
planctl epics --format yaml
```

``--format human`` activates tree/table text views for ``list``, ``epics``,
and ``show``; other verbs fall back to JSON when no human renderer is defined.

#### Epic and Task Lifecycle

```
planctl scaffold --file plan.yaml               # Mint an epic + its tasks (see below)
planctl refine-apply EPIC_ID --file delta.yaml  # Add/rewrite tasks on an existing epic
planctl claim TASK_ID                           # Assert + claim + return briefing
planctl done TASK_ID --summary "..."            # Complete with summary
planctl block TASK_ID --reason "Waiting on X"  # Mark blocked
planctl task reset TASK_ID                      # Reset to todo
planctl task ack TASK_ID                        # Ack a worker drain (clear approval gate)
planctl epic close EPIC_ID                      # Close when all tasks done
planctl epic ack EPIC_ID                        # Ack a closer drain (clear approval gate)
planctl epic invalidate EPIC_ID                 # Clear validation marker (force re-validate)
```

#### Scaffold a whole epic tree from one YAML (fn-544)

`planctl scaffold --file <plan.yaml>` materializes an epic + N tasks + cross-task
deps + per-task specs in one transactional call (assert-all -> mutate -> emit).
Returns the freshly-allocated `epic_id` and the list of `task_ids` (1-based,
`<epic_id>.M`). Deps are 1-based ordinals identical to the `.M` suffix; forward
references resolve via two-pass id allocation. Writes a *declared*
`epic.depends_on_epics` list (validated upfront) but does NOT auto-discover
epic-level deps and does NOT run `validate` — those remain separate skill
steps. Each mutating verb auto-commits its own `.planctl/` scope at
``emit()``; the scaffold's single envelope drives the single chore commit.

YAML schema at a glance:

```yaml
epic:
  title: "Feature title"
  branch: optional-branch-name        # defaults to epic_id
  depends_on_epics: [fn-1-foo, ...]    # optional, existing epic ids
  snippets: [snippet-id-1, ...]        # optional, kebab-case ids
  bundles: [bundle/name, arc/slug/id]  # optional, (bundle|arc|sketch)/<name>[/<name>]
  spec: |
    ## Overview
    ...
tasks:
  - title: "First task"
    deps: []                           # 1-based ordinals into this list
    snippets: []
    bundles: []
    spec: |
      ## Description
      ...
      ## Acceptance
      - [ ] ...
      ## Done summary
      ## Evidence
  - title: "Second task"
    deps: [1]                          # depends on first task
    spec: |
      ...
```

Failure shape (no writes land): `{success:false, error:{code, message, details:[...]}}`
with codes `bad_yaml`, `spec_invalid`, `dep_invalid`, `dep_cycle`, `ref_invalid`,
`epic_dep_invalid`, `id_collision`. All validation errors are collected in one pass.

#### Querying

```
planctl list                           # Tree view (JSON by default)
planctl list --format human            # Tree text view
planctl epics                          # List epics with task counts
planctl epics --format human           # Table text view
planctl tasks --epic EPIC --status todo  # Filter tasks
planctl ready --epic EPIC              # Tasks with deps satisfied
planctl show ID                        # Detail view (auto-detects epic vs task)
planctl show ID --format human         # Labeled key:value view
planctl cat ID                         # Raw spec markdown to stdout
planctl status                         # Project overview with counts
```

#### Setting Specs

Whole-epic and whole-task spec writes go through `scaffold` (mint) and
`refine-apply` (rewrite an existing tree — adds, spec rewrites, dep rewires,
and the epic spec). Section-level patches survive as standalone verbs:
```
echo "Description text" | planctl task set-description TASK_ID
echo "- [ ] criterion" | planctl task set-acceptance TASK_ID
```

#### Dependencies

Task-to-task deps within an epic are declared in the `scaffold` / `refine-apply`
YAML (`deps:` on each task). Epic-level dependencies:
```
planctl epic add-dep EPIC_ID DEP_EPIC_ID
```

#### Commit behaviour

Every mutating verb emits a ``planctl_invocation`` payload in its JSON envelope.
The hookctl ``planctl-mutation`` hook (PreToolUse + PostToolUse on ``^Bash$``)
reads this payload and commits ``.planctl/`` state with message:

    chore(planctl): <verb> <id>[ — <detail>]

    Planctl-Op: <verb>
    Planctl-Target: <id>
    Planctl-Prev-Op: <sha of HEAD before this commit>

The CLI never calls ``git`` directly. Hook failure surfaces as a non-zero
exit from the Bash tool — the agent sees the error.

``claim`` and ``block`` are runtime-state-only verbs that emit
``planctl_invocation`` with NULL ``subject``/``files`` (they mutate only the
gitignored ``.planctl/state/``, so no commit lands).  Read-only verbs
(``show``, ``list``, etc.) emit a
``planctl_invocation`` via the click decorator but produce no commit (NULL
subject/files).

**Decorator skip (no tracking row):** ``cat`` and ``validate`` bypass the
invocation decorator entirely — they own their stdout contract (raw markdown
and a non-standard ``{"valid",...}`` envelope respectively) and appending a
trailing NDJSON line would corrupt it.  No ``planctl_invocation`` row is
emitted for these two verbs; this is intentional and accepted.

#### Environment Variables

- `PLANCTL_ACTOR` - Override identity (default: git user.email)

#### Tips

- Use ``--format yaml`` for YAML output; ``--format human`` for tree/table views
- ``planctl cat`` always emits raw markdown regardless of ``--format``
- Use `--force` on claim/done to skip dependency and assignee checks
- Task specs have four required sections: Description, Acceptance, Done summary, Evidence
- IDs are immutable once created (epic set-title changes the title, not the ID)
- Data lives in `.planctl/` in the project directory
- Use `planctl validate` to check data integrity (envelope: {valid, errors, warnings})
"""


def _lazy_import(module_name: str, func_name: str = "run"):
    """Return a lazy-loading click callback."""

    def callback(**kwargs):
        import importlib

        module = importlib.import_module(module_name)
        func = getattr(module, func_name)
        args = SimpleNamespace(**kwargs)
        return func(args)

    return callback


@click.group(cls=InvocationTrackedGroup)
@agent_help_option(AGENT_HELP)
def cli():
    """File-based task tracking for structured development workflows."""
    pass


# --- Top-level commands ---


@cli.command("init")
def init_cmd():
    """Initialize a planctl project for the current directory."""
    return _lazy_import("planctl.run_init")()


@cli.command("detect")
def detect_cmd():
    """Check if the current directory belongs to a planctl project."""
    return _lazy_import("planctl.run_detect")()


@cli.command("status")
def status_cmd():
    """Show overall project status."""
    return _lazy_import("planctl.run_status")()


@cli.command("validate")
@click.option("--epic", "epic_id", default=None, help="Validate a specific epic")
@click.option("--all", "validate_all", is_flag=True, help="Validate all epics")
def validate_cmd(epic_id, validate_all):
    """Validate project data integrity."""
    return _lazy_import("planctl.run_validate")(
        epic_id=epic_id, validate_all=validate_all
    )


_SCAFFOLD_AGENT_HELP = """\
planctl scaffold --file <plan.yaml | ->

Materialize a whole epic tree (epic + N tasks + per-task specs + cross-task
deps) in one transactional call. `--file` accepts `-` to read the YAML from
stdin (rejected on a TTY; same 1 MiB byte cap as a file path). Strict
assert-all -> mutate -> emit: every
check (YAML shape/type, per-task ensure_valid_task_spec, snippet/bundle
regex, 1-based ordinal range + self-ref, detect_cycles) runs BEFORE any
write; failures emit a structured envelope and write nothing.

YAML schema (top-level mapping):

  epic:
    title: <str>                  # required, non-empty
    branch: <str>                 # optional, defaults to epic_id
    depends_on_epics: [<eid>, ...]# optional, existing epic ids (validated upfront)
    snippets: [<id>, ...]         # optional, kebab-case ids
    bundles: [<ref>, ...]         # optional, (bundle|arc|sketch)/<name>[/<name>].
                                  # `sketch/<name>` refs are resolved at write
                                  # time against the cwd-derived authoring
                                  # project root and inlined into `snippets`
                                  # (the ref is dropped from `bundles`) so the
                                  # epic stays portable across projects; an
                                  # unresolvable sketch fails as `ref_invalid`
                                  # in the assert phase (fn-610).
    queue_jump: <bool>            # optional, default false. A scaffold YAML
                                  # opt-in sets true at mint; can also be flipped post-hoc
                                  # on an existing epic via `planctl epic
                                  # queue-jump` (/plan:next). Rides the
                                  # planctl_invocation envelope so keeper sorts
                                  # the epic above all others on the board
                                  # (`!`-prefixed sort_path).
    spec: |                       # optional, raw markdown (no H2 validation)
      ...
  tasks:                    # required, ordered list (>=1 entry)
    - title: <str>          # required, non-empty
      tier: <band>          # required, one of medium|high|xhigh|max
                            # (fn-594). Missing field is `tier_invalid`.
      deps: [<int>, ...]    # optional, 1-based ordinals into this list
      snippets: []          # optional
      bundles: []           # optional
      target_repo: <path>   # optional, absolute path (~ expanded). One task
                            # = one repo (see /plan:plan Phase 6e). Omit to
                            # default to primary_repo. epic.touched_repos is
                            # always the sorted-uniq rollup of every task's
                            # resolved target_repo — never hand-set here.
      spec: |               # required, valid four-section task spec
        ## Description
        ...
        ## Acceptance
        - [ ] ...
        ## Done summary
        ## Evidence

Returned envelope (success):

  {"success": true,
   "epic_id": "fn-<N>-<slug>",
   "task_ids": ["fn-<N>-<slug>.1", "fn-<N>-<slug>.2", ...],
   "repo_distribution": {"<repo_path>": <count>, ...},
   "planctl_invocation": {...}}

`repo_distribution` is a deterministic (sorted-key) `{repo_path: count}`
map built from the per-task resolved `target_repo` list (omitted tasks
default to `primary_repo`). Informational — additive, no exit-code or
warning change. Surfaces the cross-repo (or accidentally-all-primary)
layout for inspection at scaffold time.

Failure envelope (no writes land):

  {"success": false,
   "error": {"code": "<code>", "message": "<msg>", "details": [<per-entry>]}}

Codes: `missing_session_id` (fn-630: `CLAUDE_CODE_SESSION_ID` unset — scaffold
cannot build its commit envelope, so it refuses up front rather than writing
a tree it could not commit), `bad_yaml` (parse/shape/type — includes
non-string `target_repo` / non-string `tier`), `spec_invalid` (task spec
malformed), `ref_invalid` (snippet/bundle regex, or a `sketch/<name>` ref
failed to resolve at write time against the cwd-derived project root — fn-610),
`dep_invalid` (out-of-range/self ordinal), `dep_cycle`,
`epic_dep_invalid` (declared epic.depends_on_epics id malformed / nonexistent /
duplicated), `repo_invalid` (per-task `target_repo` is relative, empty after
strip, or carries an unresolvable `~`), `tier_invalid` (per-task `tier` is
missing or not one of medium|high|xhigh|max), `id_collision` (backstop),
`duplicate_epic` (fn-623: a sibling epic with the same slug already exists
in this project; pass `--allow-duplicate` to mint anyway — details carry
the existing id + status).

Atomicity (fn-623 + fn-630): a scaffold that fails on ANY pre-commit path —
YAML shape, spec validity, dep cycle, integrity gate, the `missing_session_id`
guard, or a raise while building the commit envelope — leaves
`scan_max_epic_id` unchanged and zero orphan files on disk. fn-623 moved the
integrity gate to an in-memory content pass (`check_epic_tree_in_memory`
accepts `epic_spec_content=`) so no spec lands before the gate passes; fn-630
closed the gap the original fix left open by (a) validating `CLAUDE_CODE_SESSION_ID`
before the first write and (b) unwinding the written tree if
`build_planctl_invocation` raises after it. The lone carve-out is a hard
commit failure AT the `emit()` boundary (`commit_failed`): the structural
writes have already landed and stay on disk uncommitted per the §10
no-rollback policy — the next mutating verb's auto-commit sweeps them.

Scope guard: scaffold writes a *declared* `epic.depends_on_epics` list
(validated upfront against on-disk epics) but does NOT auto-discover epic-level
deps and does NOT run `validate`. Those remain separate skill steps.
`scaffold` mints a fresh epic tree; the refine path (adds + spec/dep rewrites
on an EXISTING epic) goes through `refine-apply`.
"""


@cli.command("scaffold")
@click.option(
    "--file",
    "file",
    required=True,
    type=click.Path(exists=True, dir_okay=False, file_okay=True, allow_dash=True),
    help=(
        "Path to a UTF-8 YAML file describing the epic tree. Pass `-` to read "
        "from stdin (rejected on a TTY; same 1 MiB byte cap applies)."
    ),
)
@click.option(
    "--allow-duplicate",
    "allow_duplicate",
    is_flag=True,
    default=False,
    help=(
        "Mint a distinct fn-N even when an epic with the same slug already "
        "exists in this project (fn-623 escape hatch). Without this flag, "
        "a same-slug scaffold hard-errors with `duplicate_epic` and names "
        "the existing id + status in the failure envelope."
    ),
)
@agent_help_option(_SCAFFOLD_AGENT_HELP)
def scaffold_cmd(file, allow_duplicate):
    """Materialize a whole epic tree from one YAML in a single transactional call (fn-544)."""
    result = _lazy_import("planctl.run_scaffold")(
        file=file, allow_duplicate=allow_duplicate
    )
    if result:
        sys.exit(result)
    return result


_CLOSE_PREFLIGHT_AGENT_HELP = """\
planctl close-preflight <epic_id>

Read-only close-readiness fetch for the /plan:close skill. Collapses the
Phase 0a/2 hand-fired sequence (`show` for primary_repo, `tasks` for the
readiness confirm, the `set -eo pipefail` COMMIT_GROUPS bash pipeline, and the
`promptctl render-spec` snippet fetch) into one verb returning a single
envelope. Resolution is cwd-based via `resolve_project` — /plan:close already
`cd`s to primary_repo in Phase 0a, so no epic-keyed discovery is needed.

Returned envelope (success, exit 0):

  {"success": true,
   "primary_repo": "<abs-path>",
   "tasks": [{"id", "title", "status"}, ...],
   "all_done": <bool>,         # every task status == "done"
   "commit_groups": [{"repo", "shas": [...]}, ...],
   "snippet_context": "<promptctl render-spec output>",
   "planctl_invocation": {...}}   # read-only invocation line (decorator-emitted)

`commit_groups` shells `keeper find-task-commit` per task and groups by repo
(first-seen order) — it FAILS LOUD on the first keeper failure rather than
truncating (replicates the old pipeline's `set -eo pipefail`). `snippet_context`
shells `promptctl render-spec <epic_id> --format human` with cwd=primary_repo;
empty stdout → "". An empty commit set yields `commit_groups: []`.

Failure envelope (no mutation; exit 1):

  {"success": false,
   "error": {"code": "<code>", "message": "<msg>", "details": {...}}}

Codes: `BAD_EPIC_ID`, `EPIC_NOT_FOUND`, `COMMIT_LOOKUP_FAILED` (first keeper
find-task-commit failure), `SNIPPET_RENDER_FAILED` (render-spec non-zero exit).
"""


@cli.command("close-preflight")
@click.argument("epic_id")
@click.option(
    "--project",
    default=None,
    help=(
        "Absolute path to the planctl project (bypasses cwd-walk). "
        "Mirrors `claim`'s --project flag (fn-589 task .1, item 4). "
        "Relative paths raise UsageError; unset falls back to the existing "
        "resolve_project() cwd-walk."
    ),
)
@agent_help_option(_CLOSE_PREFLIGHT_AGENT_HELP)
def close_preflight_cmd(epic_id, project):
    """Read-only close-readiness fetch: emit {primary_repo, tasks, all_done, commit_groups, snippet_context} for /plan:close (fn-565)."""
    return _lazy_import("planctl.run_close_preflight")(epic_id=epic_id, project=project)


_REFINE_CONTEXT_AGENT_HELP = """\
planctl refine-context <epic_id> [--invalidate]

Read-only refine-state fetch for the /plan:plan skill. Collapses the Phase R2
hand-fired sequence (`show` for epic metadata, `cat <epic>` for the epic spec
markdown, `tasks --epic` for the child task list, and per-task `cat <task_id>`
for each existing task spec) into one verb returning a single envelope.
Resolution is cwd-based via `resolve_project` — matching today's cwd-bound
refine reads.

[MUTATING] With `--invalidate`, also clears `last_validated_at` on the epic in
the same call — one envelope, one auto-commit. Collapses /plan:plan Phase R1's
hand-fired `epic invalidate` + Phase R2's read-only `refine-context` into one
round trip. Mirrors `validate --epic`'s conditionally-mutating precedent: the
flag flips the verb from read-only to mutating; without the flag, behavior is
read-only and unchanged.

Both refine routes consume this verb: the epic route reads the whole tree; the
task route derives `epic_id` by stripping the `.M` suffix and reuses the same
envelope (it needs the parent `epic_spec_md` for context).

Returned envelope (success, exit 0):

  {"success": true,
   "epic_id": "<epic_id>",
   "title": "<str>" | null,
   "branch": "<str>" | null,           # epic.branch_name
   "last_validated_at": "<iso>" | null,
   "epic_spec_md": "<raw markdown>",    # "" when the spec is absent
   "tasks": [{"id", "title", "status", "deps", "snippets", "bundles", "spec_md"}, ...],
   "planctl_invocation": {...}}         # read-only invocation line (decorator-emitted)

`tasks` is `[]` for an empty epic. Each task entry carries its own `spec_md`
so the caller never re-fires `cat` per task. `last_validated_at` is surfaced so
the refine path's R4 step can branch on whether the epic was ever validated.

Failure envelope (no mutation; exit 1):

  {"success": false,
   "error": {"code": "<code>", "message": "<msg>", "details": {...}}}

Codes: `BAD_EPIC_ID`, `EPIC_NOT_FOUND`.
"""


@cli.command("refine-context")
@click.argument("epic_id")
@click.option(
    "--invalidate",
    is_flag=True,
    default=False,
    help=(
        "[MUTATING] Clear last_validated_at on the epic in the same call. "
        "Collapses /plan:plan Phase R1's `epic invalidate` + Phase R2's "
        "`refine-context` into one round trip. Without the flag, behavior is "
        "read-only and unchanged. Mirrors validate --epic's "
        "conditionally-mutating precedent — one envelope + one commit."
    ),
)
@agent_help_option(_REFINE_CONTEXT_AGENT_HELP)
def refine_context_cmd(epic_id, invalidate):
    """Refine-state fetch: emit {title, branch, last_validated_at, epic_spec_md, tasks[]} for /plan:plan (fn-565).

    Read-only by default; with --invalidate also clears last_validated_at
    in the same call (single envelope + single commit, fn-589 task .1).
    """
    return _lazy_import("planctl.run_refine_context")(
        epic_id=epic_id, invalidate=invalidate
    )


_REFINE_APPLY_AGENT_HELP = """\
planctl refine-apply <epic_id> --file <delta.yaml | ->

`--file` accepts `-` to read the YAML delta from stdin (rejected on a TTY;
same 1 MiB byte cap as a file path).

Refine's mutating batch verb — applies a refine DELTA to an EXISTING epic tree
in one transactional, assert-all, collect-all call (the refine equivalent of
`scaffold`, but over an epic that already exists). Collapses the /plan:plan
R5b (epic route) / R5c (task route) hand-fired loop (`task create` ->
`set-spec` -> `set-deps` -> `epic set-plan`, repeated per task) into one verb.

Delta YAML shape (all four sections optional; supply at least one):

  epic:
    spec: |                # optional epic spec rewrite (raw markdown)
      ## Overview
      ...
  add_tasks:                # optional list of brand-new tasks
    - title: <str>
      tier: <band>          # required, one of medium|high|xhigh|max
                            # (fn-594). Missing field is `tier_invalid` —
                            # same enforcement as scaffold.
      spec: |               # four-section validated
        ## Description
        ...
      deps: [fn-7.1, 2]     # mix existing task ids (str) + 1-based new-ordinal (int)
      snippets: [...]       # optional
      bundles: [...]        # optional. `sketch/<name>` refs are inlined into
                            # `snippets` at write time against the cwd-derived
                            # authoring project root and dropped from `bundles`
                            # (fn-610); an unresolvable sketch fails as
                            # `ref_invalid` in the assert phase. Applies to
                            # epic.bundles rewrites as well.
      target_repo: <path>   # optional, absolute path (~ expanded). One task
                            # = one repo (see /plan:plan Phase 6e). Omit to
                            # default to epic.primary_repo. epic.touched_repos
                            # is recomputed on every refine-apply as the
                            # sorted-uniq rollup of existing-task + new-task
                            # target_repos — never hand-set here.
  rewrite_specs:            # optional spec rewrites on existing tasks
    - task_id: fn-7.2
      spec: | ...
  rewire_deps:              # optional FULL dep-list replacement on existing tasks
    - task_id: fn-7.2
      deps: [fn-7.1]        # empty list clears deps; replacement, not add

No hard task deletion (planctl's graph is append-only). "Retire" a task via a
`rewrite_specs` entry marking it obsolete + a separate `task reset`.

Assert-all -> mutate -> emit: every check (YAML shape, epic existence, per-spec
four-section validation, snippet/bundle regex, target-task existence,
post-delta dep existence + new-ordinal range + self-ref, `detect_cycles` on the
POST-delta graph, new-task id collision) runs upfront and collects ALL errors in
one pass BEFORE any write; on failure it emits a structured
`{success:false, error:{code, message, details:[per-entry]}}` envelope (codes
`bad_yaml` — includes non-string `add_tasks[].target_repo` / non-string
`add_tasks[].tier`, `epic_not_found`, `spec_invalid`, `ref_invalid`,
`target_invalid`, `dep_invalid`, `dep_cycle`, `repo_invalid` — add_tasks
`target_repo` is relative, empty after strip, or carries an unresolvable `~`,
`tier_invalid` — add_tasks `tier` is missing or not one of
medium|high|xhigh|max, `id_collision`) and writes nothing.

Because it rewrites specs/deps on an EXISTING epic, refine-apply CLEARS the
epic's `last_validated_at` (joins VALIDATION_RESTAMP_VERBS) — the core asymmetry
with `scaffold`, which mints a fresh epic whose marker already defaults to null.
Success returns `{epic_id, added_task_ids, rewritten_specs, rewired_deps,
epic_spec_rewritten}` and emits exactly ONE planctl_invocation envelope covering
the whole delta. Atomicity: assert-all eliminates the validation-failure
partial-write class; the residual crash-mid-write window is per-file (atomic.py
is per-file rename, not tree-level), same posture as scaffold.
"""


@cli.command("refine-apply")
@click.argument("epic_id")
@click.option(
    "--file",
    "file",
    required=True,
    type=click.Path(exists=True, dir_okay=False, file_okay=True, allow_dash=True),
    help=(
        "Path to a UTF-8 YAML file describing the refine delta. Pass `-` to "
        "read from stdin (rejected on a TTY; same 1 MiB byte cap applies)."
    ),
)
@agent_help_option(_REFINE_APPLY_AGENT_HELP)
def refine_apply_cmd(epic_id, file):
    """Apply a refine delta (adds + spec-rewrites + dep-rewires + epic-spec) to an existing epic in one transactional call (fn-565)."""
    result = _lazy_import("planctl.run_refine_apply")(epic_id=epic_id, file=file)
    if result:
        sys.exit(result)
    return result


@cli.command("state-path")
@click.option("--task", "task_id", default=None, help="Task ID for specific state path")
def state_path_cmd(task_id):
    """Print the resolved state directory path."""
    return _lazy_import("planctl.run_state_path")(task_id=task_id)


@cli.command("claim")
@click.argument("task_id")
@click.option("--force", is_flag=True, help="Skip dependency and assignee checks")
@click.option("--note", default=None, help="Claim note")
@click.option(
    "--project",
    default=None,
    help=(
        "Project path to resolve the task in, bypassing roots discovery. "
        "Use this for tasks in projects outside the configured roots, or to "
        "disambiguate an AMBIGUOUS_TASK_ID."
    ),
)
def claim_cmd(task_id, force, note, project):
    """Assert invariants, claim a task, and return the full worker briefing.

    Resolves the owning project cwd-agnostically: scans the configured ``roots``
    (~/.config/planctl/config.yaml) for the project holding the task, or use
    --project <path> to target one directly. Works from any directory.
    """
    return _lazy_import("planctl.run_claim")(
        task_id=task_id, force=force, note=note, project=project
    )


@cli.command("resolve-task")
@click.argument("task_id")
@click.option(
    "--project",
    default=None,
    help=(
        "Project path to resolve the task in, bypassing roots discovery. "
        "Use this for tasks in projects outside the configured roots, or to "
        "disambiguate an AMBIGUOUS_TASK_ID."
    ),
)
def resolve_task_cmd(task_id, project):
    """Read-only routing lookup — return the fields needed to launch /plan:work.

    The arthack-claude launcher calls this once before launching claude to
    decide which tier-plugin's --plugin-dir to inject. Read-only: no .planctl/
    write, no commit. Cwd-agnostic (scans configured roots). Returns
    {task_id, epic_id, project_path, target_repo, primary_repo, tier, status};
    field names overlap with `claim` so the launcher has one parser.
    """
    return _lazy_import("planctl.run_resolve_task")(task_id=task_id, project=project)


@cli.command("done")
@click.argument("task_id")
@click.option("--summary", default=None, help="Completion summary text")
@click.option("--evidence", default=None, help="Inline evidence JSON string")
@click.option("--force", is_flag=True, help="Skip assignee check")
def done_cmd(task_id, summary, evidence, force):
    """Mark a task as complete."""
    return _lazy_import("planctl.run_done")(
        task_id=task_id,
        summary=summary,
        evidence=evidence,
        force=force,
    )


@cli.command("block")
@click.argument("task_id")
@click.option("--reason", default=None, help="Block reason text")
@click.option("--reason-file", default=None, help="Path to reason file")
def block_cmd(task_id, reason, reason_file):
    """Mark a task as blocked."""
    return _lazy_import("planctl.run_block")(
        task_id=task_id, reason=reason, reason_file=reason_file
    )


@cli.command("ready")
@click.option("--epic", "epic_id", required=True, help="Epic ID")
def ready_cmd(epic_id):
    """List tasks that are ready to be worked on."""
    return _lazy_import("planctl.run_ready")(epic_id=epic_id)


@cli.command("show")
@click.argument("id")
def show_cmd(id):
    """Show detailed information about an epic or task."""
    return _lazy_import("planctl.run_show")(id=id)


@cli.command("epics")
def epics_cmd():
    """List all epics."""
    return _lazy_import("planctl.run_epics")()


@cli.command("tasks")
@click.option("--epic", "epic_id", default=None, help="Filter by epic ID")
@click.option("--status", default=None, help="Filter by status")
def tasks_cmd(epic_id, status):
    """List tasks with optional filtering."""
    return _lazy_import("planctl.run_tasks")(epic_id=epic_id, status=status)


@cli.command("list")
def list_cmd():
    """List all epics and their tasks in a tree view."""
    return _lazy_import("planctl.run_list")()


@cli.command("cat")
@click.argument("id")
def cat_cmd(id):
    """Print the raw spec markdown for an epic or task."""
    return _lazy_import("planctl.run_cat")(id=id)


@cli.command("render-approve-context")
@click.argument("id")
def render_approve_context_cmd(id):
    """Emit the markdown approve-context document for an epic or task.

    Format-free verb that pulls keeper-projected lifecycle data through
    keeper-py, picks the freshest target job, reads its transcript JSONL,
    and emits the byte-for-byte marker-bearing markdown the ``/plan:approve``
    SKILL.md cascade parses (``## last message`` wrapped in
    ``--- BEGIN/END TRANSCRIPT ---``; ``## ERROR: keeperd unavailable`` and
    ``## ERROR: no readable final message`` markers exit 0; spec-error
    "id not found / no job" exits non-zero).  The transcript body is
    sanitized so a worker cannot break out of the evidence delimiters and
    self-approve.

    Registered in ``_NO_TRACK_COMMANDS`` so the invocation decorator does
    NOT append a trailing ``planctl_invocation`` NDJSON line — appending
    one would corrupt the marker contract the skill body matches on.
    """
    result = _lazy_import("planctl.run_render_approve_context")(id=id)
    # click drops the callback's return value silently in standalone mode —
    # mirror the ``scaffold`` / ``refine-apply`` shape and sys.exit on a
    # non-zero rc so the marker-contract failure modes (RenderError → exit 1)
    # actually surface to the shell.
    if result:
        sys.exit(result)
    return result


@cli.command("gist")
@click.argument("epic_id")
@click.option("--public", is_flag=True, help="Make the gist public (default: secret)")
@click.option("--no-open", is_flag=True, help="Don't open the gist in a browser")
@click.option("--desc", "description", default=None, help="Gist description")
def gist_cmd(epic_id, public, no_open, description):
    """Create a multifile gist for an epic: TOC + epic spec + task specs."""
    return _lazy_import("planctl.run_gist")(
        epic_id=epic_id,
        public=public,
        no_open=no_open,
        description=description,
    )


_APPROVE_AGENT_HELP = """\
planctl approve <epic_id> [<task_id>] <status>

Set the approval gate on an epic or a task. fn-592 promotes the approval
state from keeper's `approvals` SQLite sidecar into a top-level field on the
canonical planctl JSON. Two forms:

  planctl approve <epic_id> <status>              # epic-level
  planctl approve <epic_id> <task_id> <status>    # task-level

``<status>`` is one of: ``approved``, ``rejected``, ``pending``. Invalid
values are rejected by click.Choice before any I/O. ``pending`` is the
implicit default for new epics/tasks (missing field == pending), but an
explicit ``approve ... pending`` is supported so an operator can flip a
previously-approved epic back into the gate.

Writes atomically via temp+rename in the same directory. Round-trip
preserves all unknown top-level fields (forward-compat with keeperd writers
that may add fields planctl doesn't yet know about).

NOT in VALIDATION_RESTAMP_VERBS — approval is human gating state, not
structural plan content; flipping it must not invalidate the epic's
``last_validated_at`` marker.

**Approval gates (fn-592 task .1).** When ``<status> == "approved"`` the
verb refuses to write unless the target is in a clean approvable state:

  * Task approve: the merged task ``status`` must be ``"done"``.
  * Epic approve: the epic ``status`` must be ``"done"`` AND every embedded
    task must have merged ``status == "done"`` AND every embedded task must
    have ``approval == "approved"``.

``rejected`` and ``pending`` writes are unguarded.  External writers
(keeperd's ``set_task_approval`` / ``set_epic_approval`` RPCs) bypass these
gates by design — they write the JSON directly, not via this CLI.

**Cwd-agnostic resolution.** Three-step lookup: ``--project <path>`` →
cwd → configured ``roots`` (~/.config/planctl/config.yaml). Cwd-first keeps
single-repo workflows working without configured roots; discovery covers
the multi-repo case (``epic.primary_repo`` in a sibling project). Pass
``--project <path>`` to bypass both — e.g. for targets outside the roots,
or to disambiguate when the same id exists in multiple discovered
projects.
"""


@cli.command("approve")
@click.argument("epic_id")
@click.argument("rest", nargs=-1, required=True)
@click.option(
    "--project",
    default=None,
    help=(
        "Project path to resolve the epic/task in, bypassing roots discovery. "
        "Use this for targets in projects outside the configured roots, or to "
        "disambiguate when the same id exists in multiple projects."
    ),
)
@agent_help_option(_APPROVE_AGENT_HELP)
def approve_cmd(epic_id, rest, project):
    """Approve an epic or task: <epic_id> [<task_id>] <status> (fn-592)."""
    from planctl.models import APPROVAL_STATUSES
    from planctl.output import emit_error

    # Two-form dispatch on positional count:
    #   `<epic_id> <status>`              -> epic-level
    #   `<epic_id> <task_id> <status>`    -> task-level
    # click.Choice can't gate this directly because the status's positional
    # slot depends on whether task_id is present; we re-validate inside the
    # runner (defense in depth for non-CLI callers).
    if len(rest) == 1:
        task_id = None
        status = rest[0]
    elif len(rest) == 2:
        task_id = rest[0]
        status = rest[1]
    else:
        emit_error(
            "approve: too many positional arguments. "
            "Usage: approve <epic_id> [<task_id>] <status>"
        )

    if status not in APPROVAL_STATUSES:
        emit_error(
            f"Invalid approval status: {status!r}. "
            f"Must be one of: {', '.join(APPROVAL_STATUSES)}"
        )

    return _lazy_import("planctl.run_approve")(
        epic_id=epic_id, task_id=task_id, status=status, project=project
    )


# --- Epic subgroup ---


@cli.group("epic", cls=FormattedGroup)
def epic_group():
    """Manage epics."""
    pass


@epic_group.command("create")
@click.option("--title", required=True, help="Epic title")
@click.option("--branch", default=None, help="Git branch name")
@click.option("--spec-file", default=None, help="Initial spec file")
@click.option(
    "--primary-repo",
    default=None,
    help="Absolute path to repo whose .planctl/ holds state (default: cwd repo)",
)
@click.option(
    "--touched-repos",
    default=None,
    help="Comma-separated list of repo paths workers may touch (default: primary-repo)",
)
def epic_create_cmd(title, branch, spec_file, primary_repo, touched_repos):
    """Create a new epic."""
    return _lazy_import("planctl.run_epic_create")(
        title=title,
        branch=branch,
        spec_file=spec_file,
        primary_repo=primary_repo,
        touched_repos=touched_repos,
    )


@epic_group.command("set-branch")
@click.argument("epic_id")
@click.option("--branch", required=True, help="Branch name")
def epic_set_branch_cmd(epic_id, branch):
    """Set the branch name on an epic."""
    return _lazy_import("planctl.run_epic_set_branch")(epic_id=epic_id, branch=branch)


@epic_group.command("set-title")
@click.argument("epic_id")
@click.option("--title", required=True, help="New title")
def epic_set_title_cmd(epic_id, title):
    """Rename an epic (ID remains unchanged)."""
    return _lazy_import("planctl.run_epic_set_title")(epic_id=epic_id, title=title)


@epic_group.command("close")
@click.argument("epic_id")
@click.option("--force", is_flag=True, help="Close even if tasks are not all done")
@click.option(
    "--reason", default=None, help="Why the epic was closed (e.g. audited, discarded)"
)
def epic_close_cmd(epic_id, force, reason):
    """Mark an epic as done."""
    return _lazy_import("planctl.run_epic_close")(
        epic_id=epic_id,
        force=force,
        reason=reason,
    )


_EPIC_RM_AGENT_HELP = """\
planctl epic rm <epic_id> [--force] [--dry-run] [--project <path>]

Sanctioned delete verb for an epic and every artifact it owns: the epic
JSON, every child task JSON, the epic spec markdown, every task spec
markdown, runtime state files, and lock files. Unlinks them all and
auto-commits the deletions into the owning project's `.planctl/` via the
standard `planctl_invocation` envelope path (so the state commit lands in
`epic.primary_repo`, not the caller's cwd — same routing as `approve`).

Resolution is cwd-then-global via `discovery.resolve_epic_globally`: if
cwd is a planctl project carrying the id, it wins; otherwise scan the
configured roots. An id that lives in two or more projects is an
`ambiguous_id` hard error listing every owner — pass `--project <path>`
to disambiguate. `--project` also bypasses cwd-walk for operators who
want to operate on a foreign project without `cd`'ing.

Guards:
  * `--dry-run` previews the unlink set and exits without writing.
  * `in_progress` tasks (or any task holding a `.lock`) block deletion
    unless `--force`.
  * Missing files are idempotent success.
  * `epic_id` is traversal-guarded (`[A-Za-z0-9_-]+`).
  * Downstream dependents (other epics with `depends_on_epics` pointing
    at the target) are SURFACED in `warnings`, never blockers. Keeper
    re-stamps them `dangling` on the EpicDeleted fold.

Returned envelope (success, exit 0):

  {"success": true,
   "epic_id": "<epic_id>",
   "removed_files": ["<repo-relative path>", ...],
   "task_count": <int>,
   "dependents": ["<epic_id>", ...],
   "warnings": ["<one-line warning>", ...],
   "planctl_invocation": {...}}

`--dry-run` emits the same shape minus `planctl_invocation` (no write =
no auto-commit) plus an explicit `"dry_run": true` field.

Failure envelope (exit 1):

  {"success": false, "error": "<one-line message>"}

Failure conditions: invalid id (traversal), ambiguous id without
`--project`, epic not found, live tasks without `--force`, project path
not a planctl project.
"""


@epic_group.command("rm")
@click.argument("epic_id")
@click.option(
    "--force",
    is_flag=True,
    default=False,
    help="Delete even if tasks are in_progress or hold locks",
)
@click.option(
    "--dry-run",
    is_flag=True,
    default=False,
    help="Print the unlink set and exit without deleting anything",
)
@click.option(
    "--project",
    default=None,
    help=(
        "Absolute path to the owning planctl project (bypasses "
        "cwd-then-global resolution). Required to disambiguate when the "
        "epic id lives in multiple projects."
    ),
)
@agent_help_option(_EPIC_RM_AGENT_HELP)
def epic_rm_cmd(epic_id, force, dry_run, project):
    """Remove an epic and all its artifacts (sanctioned delete verb, fn-623)."""
    return _lazy_import("planctl.run_epic_rm")(
        epic_id=epic_id,
        force=force,
        dry_run=dry_run,
        project=project,
    )


@epic_group.command("ack")
@click.argument("epic_id")
def epic_ack_cmd(epic_id):
    """Acknowledge a closer drain so the approval gate clears (fn-386)."""
    return _lazy_import("planctl.run_epic_ack")(epic_id=epic_id)


@epic_group.command("invalidate")
@click.argument("epic_id")
def epic_invalidate_cmd(epic_id):
    """Clear validation marker (force re-validate on next validate run)."""
    return _lazy_import("planctl.run_epic_invalidate")(epic_id=epic_id)


@epic_group.command("queue-jump")
@click.argument("epic_id")
def epic_queue_jump_cmd(epic_id):
    """Flip queue_jump=true so the epic sorts to the front of the board (/plan:next)."""
    return _lazy_import("planctl.run_epic_queue_jump")(epic_id=epic_id)


@epic_group.command("add-dep")
@click.argument("epic_id")
@click.argument("dep_id")
def epic_add_dep_cmd(epic_id, dep_id):
    """Add an epic-level dependency."""
    return _lazy_import("planctl.run_epic_add_dep")(epic_id=epic_id, dep_id=dep_id)


_EPIC_ADD_DEPS_AGENT_HELP = """\
planctl epic add-deps <epic_id> <dep_id> [<dep_id> ...] [--skip-invalid]

Batch-wire N epic-level dependency edges in one transactional call. Idempotent
per edge (an already-wired dep returns `ALREADY_PRESENT` — no-op, not an error).
Collapses the /plan:plan Phase 6 hand-fired loop (whitelist prefetch via
`planctl epics` + per-edge `epic add-dep`) into one verb.

Default (no flag) is fail-loud: any per-edge classifier error (malformed id,
self-ref, target not on disk, target already done, cycle) emits a structured
failure envelope collecting EVERY bad edge in one pass and writes nothing.

With `--skip-invalid`: per-edge classifier errors land as `SKIPPED_*` statuses
in the results array (status enum below) and exit stays 0 with a success
envelope, symmetric with today's all-already-present no-write path. Used by
/plan:plan to drop the whitelist prefetch — the verb is the validator now.

Returned envelope (success, exit 0):

  {"success": true,
   "epic_id": "<epic_id>",
   "results": [
     {"dep_id": "<eid>", "status": "WIRED"|"ALREADY_PRESENT"|
                                   "SKIPPED_BAD_ID"|"SKIPPED_SELF_REF"|
                                   "SKIPPED_NOT_FOUND"|"SKIPPED_AMBIGUOUS"|
                                   "SKIPPED_DONE"|"SKIPPED_CYCLE",
      "reason": "<one-line rationale, present on SKIPPED_*>"},
     ...
   ],
   "planctl_invocation": {...}}

`WIRED` indicates the edge was newly written this call. `ALREADY_PRESENT`
indicates the edge was already on disk (no write). `SKIPPED_*` only appears
under `--skip-invalid`; without the flag those errors would have failed the
whole call.

Failure envelope (no writes land, default mode only):

  {"success": false,
   "error": {"code": "<code>", "message": "<msg>", "details": [<per-edge>]}}

Codes: `bad_id`, `dep_ambiguous_id`, `epic_not_found`, `dep_done`, `dep_cycle`.

fn-600: dep existence is resolved cwd-then-global, so a dep id that lives in
a sibling project (under a configured root) wires cleanly. Legacy dup state
where the same id appears in two projects surfaces as `dep_ambiguous_id`
listing every owning project path — never a silent last-walked pick.
"""


@epic_group.command("add-deps")
@click.argument("epic_id")
@click.argument("dep_ids", nargs=-1, required=True)
@click.option(
    "--skip-invalid",
    is_flag=True,
    default=False,
    help=(
        "Route per-edge classifier errors (bad id / self-ref / not found / "
        "done) into the results array as SKIPPED_* statuses instead of "
        "failing the whole call. Exit 0 with a success envelope even when "
        "every edge skips. Default (no flag) preserves the fail-loud "
        "behavior. Used by /plan:plan to drop the whitelist prefetch."
    ),
)
@agent_help_option(_EPIC_ADD_DEPS_AGENT_HELP)
def epic_add_deps_cmd(epic_id, dep_ids, skip_invalid):
    """Batch-wire N epic-level dependency edges (idempotent per edge).

    With --skip-invalid, per-edge errors land as SKIPPED_* statuses in the
    results array and exit stays 0 (fn-589 task .1, item 9).
    """
    return _lazy_import("planctl.run_epic_add_deps")(
        epic_id=epic_id, dep_ids=list(dep_ids), skip_invalid=skip_invalid
    )


@epic_group.command("rm-dep")
@click.argument("epic_id")
@click.argument("dep_id")
def epic_rm_dep_cmd(epic_id, dep_id):
    """Remove an epic-level dependency."""
    return _lazy_import("planctl.run_epic_rm_dep")(epic_id=epic_id, dep_id=dep_id)


_EPIC_FOLLOWUP_OF_AGENT_HELP = """\
planctl epic followup-of <source_epic_id>

Read-only follow-up lookup for the /plan:close skill (fn-589 task .1, item 7).
Collapses Phase 7's hand-fired `epics --status open` + per-row JSON walk into
one verb returning a single envelope.  Scans open epics for the one whose
`depends_on_epics` contains <source_epic_id>; returns the first hit in
alphabetic (sorted) filename order — deterministic across filesystems.

Returned envelope (success, exit 0):

  Found:    {"success": true,
             "found": true,
             "epic_id": "<follow-up epic id>",
             "actual_tasks": <int>,
             "depends_on_epics": [<source>, ...],
             "status": "<open|closed|done>",
             "planctl_invocation": {...}}    # readonly invocation line
  Absent:   {"success": true,
             "found": false,
             "planctl_invocation": {...}}

The verb does NOT compute "completeness" — the caller compares
`actual_tasks` against its in-memory expected count.

Failure envelope (no mutation; exit 1):

  {"success": false,
   "error": {"code": "<code>", "message": "<msg>", "details": {...}}}

Codes: `BAD_EPIC_ID`.  A missing source epic is NOT an error — the verb
still returns `{found: false}` because no follow-up can wire to a dep that
doesn't exist on disk, so the answer to "is there a follow-up?" is no.
"""


@epic_group.command("followup-of")
@click.argument("source_epic_id")
@agent_help_option(_EPIC_FOLLOWUP_OF_AGENT_HELP)
def epic_followup_of_cmd(source_epic_id):
    """Find a single open epic that depends on <source_epic_id> (fn-589 task .1, item 7)."""
    return _lazy_import("planctl.run_epic_followup_of")(source_epic_id=source_epic_id)


@epic_group.command("set-primary-repo")
@click.argument("epic_id")
@click.option(
    "--path",
    required=True,
    help=(
        "Absolute path to the repo that holds .planctl/ state for this epic. "
        "METADATA ONLY — does not physically move .planctl/ files. "
        "You must move the directory manually after updating this field."
    ),
)
def epic_set_primary_repo_cmd(epic_id, path):
    """Set the primary_repo path on an epic (metadata only)."""
    return _lazy_import("planctl.run_epic_set_primary_repo")(epic_id=epic_id, path=path)


@epic_group.command("set-touched-repos")
@click.argument("epic_id")
@click.option(
    "--paths",
    required=True,
    help="Comma-separated list of repo paths workers may touch (replaces existing list)",
)
def epic_set_touched_repos_cmd(epic_id, paths):
    """Replace the touched_repos list on an epic."""
    return _lazy_import("planctl.run_epic_set_touched_repos")(
        epic_id=epic_id, paths=paths
    )


@epic_group.command("set-snippets")
@click.argument("epic_id")
@click.option(
    "--snippets",
    default="",
    help=(
        "Comma-separated snippet ids (replaces existing list). "
        "Empty string or omitted clears the list."
    ),
)
def epic_set_snippets_cmd(epic_id, snippets):
    """Replace the snippet-id list on an epic (spec metadata)."""
    return _lazy_import("planctl.run_epic_set_snippets")(
        epic_id=epic_id, snippets=snippets
    )


@epic_group.command("set-bundles")
@click.argument("epic_id")
@click.option(
    "--bundles",
    default="",
    help=(
        "Comma-separated bundle refs (replaces existing list). "
        "Each ref: (bundle|arc|sketch)/<name>[/<name>]. "
        "`sketch/<name>` refs are resolved at write time against the "
        "cwd-derived authoring project root and inlined into `snippets` "
        "(dropped from the persisted bundle list) so the record stays "
        "portable; an unresolvable sketch fails as `ref_invalid` (fn-610). "
        "Empty string or omitted clears the list."
    ),
)
def epic_set_bundles_cmd(epic_id, bundles):
    """Replace the bundle-ref list on an epic (spec metadata)."""
    return _lazy_import("planctl.run_epic_set_bundles")(
        epic_id=epic_id, bundles=bundles
    )


# --- Task subgroup ---


@cli.group("task", cls=FormattedGroup)
def task_group():
    """Manage tasks."""
    pass


@task_group.command("set-description")
@click.argument("task_id")
@click.option("--file", "file", default=None, help="Path to description file")
@click.option("--message", default=None, help="Change message")
def task_set_description_cmd(task_id, file, message):
    """Set or replace the Description section of a task spec."""
    return _lazy_import("planctl.run_task_set_description")(
        task_id=task_id, file=file, message=message
    )


@task_group.command("set-acceptance")
@click.argument("task_id")
@click.option("--file", "file", default=None, help="Path to acceptance file")
@click.option("--message", default=None, help="Change message")
def task_set_acceptance_cmd(task_id, file, message):
    """Set or replace the Acceptance section of a task spec."""
    return _lazy_import("planctl.run_task_set_acceptance")(
        task_id=task_id, file=file, message=message
    )


@task_group.command("set-snippets")
@click.argument("task_id")
@click.option(
    "--snippets",
    default="",
    help=(
        "Comma-separated snippet ids (replaces existing list). "
        "Empty string or omitted clears the list."
    ),
)
def task_set_snippets_cmd(task_id, snippets):
    """Replace the snippet-id list on a task (spec metadata)."""
    return _lazy_import("planctl.run_task_set_snippets")(
        task_id=task_id, snippets=snippets
    )


@task_group.command("set-bundles")
@click.argument("task_id")
@click.option(
    "--bundles",
    default="",
    help=(
        "Comma-separated bundle refs (replaces existing list). "
        "Each ref: (bundle|arc|sketch)/<name>[/<name>]. "
        "`sketch/<name>` refs are resolved at write time against the "
        "cwd-derived authoring project root and inlined into `snippets` "
        "(dropped from the persisted bundle list) so the record stays "
        "portable; an unresolvable sketch fails as `ref_invalid` (fn-610). "
        "Empty string or omitted clears the list."
    ),
)
def task_set_bundles_cmd(task_id, bundles):
    """Replace the bundle-ref list on a task (spec metadata)."""
    return _lazy_import("planctl.run_task_set_bundles")(
        task_id=task_id, bundles=bundles
    )


@task_group.command("reset")
@click.argument("task_id")
@click.option("--cascade", is_flag=True, help="Also reset dependent tasks")
def task_reset_cmd(task_id, cascade):
    """Reset a task to todo status."""
    return _lazy_import("planctl.run_task_reset")(task_id=task_id, cascade=cascade)


@task_group.command("ack")
@click.argument("task_id")
def task_ack_cmd(task_id):
    """Acknowledge a worker drain so the approval gate clears (fn-386)."""
    return _lazy_import("planctl.run_task_ack")(task_id=task_id)


@task_group.command("set-target-repo")
@click.argument("task_id")
@click.option(
    "--path",
    required=True,
    help="Repo path where the worker executes for this task",
)
def task_set_target_repo_cmd(task_id, path):
    """Set the target_repo path on a task."""
    return _lazy_import("planctl.run_task_set_target_repo")(task_id=task_id, path=path)


@task_group.command("set-tier")
@click.argument("task_id")
@click.option(
    "--tier",
    required=True,
    type=click.Choice(["medium", "high", "xhigh", "max"]),
    help="Worker reasoning tier (used by /plan:work cold-resume to skip the heuristic)",
)
def task_set_tier_cmd(task_id, tier):
    """Persist the worker reasoning tier on a task (fn-405)."""
    return _lazy_import("planctl.run_task_set_tier")(task_id=task_id, tier=tier)


# --- Worker subgroup (arthack divergence from upstream flowctl) ---


@cli.group("worker", cls=FormattedGroup)
def worker_group():
    """Worker resume helpers for dropped /plan:work invocations."""
    pass


_WORKER_RESUME_AGENT_HELP = """\
planctl worker resume <task_id>

Read-only helper for /plan:work's Phase 2b cold-resume path. Emits a
ready-to-paste CONTEXT preamble describing how a cross-session resume should
re-enter the harness-dropped worker, plus the persisted runtime metadata the
spawning skill needs to pick the right tier WITHOUT a second `planctl show`
round trip.

Returned envelope (success, exit 0):

  {"success": true,
   "prompt": "<full CONTEXT preamble for the respawn>",
   "task_id": "<fn-N-slug.M>",
   "status": "<todo|in_progress|done|blocked>",
   "tier": "medium"|"high"|"xhigh"|"max"|null,
   "planctl_invocation": {...}}        # readonly invocation line

`tier` is the persisted runtime field (`planctl task set-tier` writes it from
/plan:work Phase 2a). It is surfaced as an explicit JSON `null` (not key
omission) when the task never had a tier persisted — the skill cold-path
branches on `tier is None` to fall through to the spec-content heuristic.
Surfacing tier here lets the cold-resume path read it from the resume envelope
directly instead of shelling `planctl show <task_id> --format json | jq` for
the same field — one round trip per cold spawn, fn-589 task .1 item 5.

`status` mirrors the same runtime field the cold path was about to re-read; a
fresh value off this envelope is the deterministic input for the
harness-dropped-predecessor branch inside the worker agent spec's Phase 1.

The verb is read-only — no .planctl/ writes, no auto-commit (envelope carries
the read-only invocation line via the decorator path).

Failure envelope (no mutation; exit 2):

  {"success": false,
   "error": {"code": "<code>", "message": "<msg>"}}

Codes: `BAD_TASK_ID` (regex), `TASK_NOT_FOUND` (spec/JSON absent).
"""


@worker_group.command("resume")
@click.argument("task_id")
@agent_help_option(_WORKER_RESUME_AGENT_HELP)
def worker_resume_cmd(task_id):
    """Emit a ready-to-paste respawn prompt for a dropped in-progress task."""
    return _lazy_import("planctl.run_worker_resume")(task_id=task_id)


def main() -> int:
    """Main entry point."""
    from planctl._util import run_cli

    return run_cli(cli)


if __name__ == "__main__":
    sys.exit(main())
