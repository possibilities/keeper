"""planctl scaffold - Materialize a whole epic tree in one transactional call (fn-544).

Reads a single YAML describing an epic and its ordered task list (deps as
1-based ordinals = the ``.M`` suffix), validates everything upfront collecting
ALL errors, allocates ids under the global epic-id flock, writes the whole
tree in one touched-paths session via the existing ``atomic_write*`` machinery,
and emits one ``planctl_invocation`` envelope.

Execution order is strict **assert-all → mutate → emit**. Scope guard: scaffold
writes a *declared* ``epic.depends_on_epics`` list but does NOT auto-discover
epic-level deps and does NOT run ``validate`` — those remain separate skill
steps. The git commit lands automatically via ``output.emit()``'s per-verb
auto-commit (fn-587), driven by the single ``planctl_invocation`` envelope.

Failure shape: on any PRE-commit failure (validation, integrity gate, the
``missing_session_id`` guard, or a raise while building the commit envelope),
emits a structured ``{success:false, error:{code, message, details:[<per-entry>]}}``
envelope on stdout, exits non-zero, and leaves ZERO filesystem mutation —
``scan_max_epic_id`` is unchanged and no ``specs/fn-N-*.md`` orphan remains
(fn-630 extended the fn-623 atomicity invariant across the write + envelope
phases). The lone carve-out is a hard commit failure AT the ``emit()`` boundary,
which prints ``commit_failed`` and leaves the written tree on disk uncommitted
per the §10 no-rollback policy (the next mutating verb's auto-commit sweeps it).
Codes:

- ``missing_session_id`` — ``CLAUDE_CODE_SESSION_ID`` is unset (fn-630): scaffold
  cannot build its commit envelope, so it refuses up front rather than writing a
  tree it could not commit
- ``bad_yaml`` — parse/shape/type failure
- ``spec_invalid`` — a task spec failed ``ensure_valid_task_spec``
- ``dep_invalid`` — out-of-range or self-referential ordinal
- ``dep_cycle`` — the resolved in-memory graph has a cycle
- ``ref_invalid`` — snippet/bundle regex rejected a ref, or a ``sketch/<name>``
  ref failed to resolve at write time against the cwd-derived project root
  (fn-610 inlines resolvable sketches into the persisted ``snippets`` list so
  worker-time ``render-spec`` never sees an unresolvable cross-project ref)
- ``epic_dep_invalid`` — a declared ``epic.depends_on_epics`` id is malformed,
  nonexistent, or duplicated
- ``repo_invalid`` — per-task ``target_repo`` is relative, empty after strip,
  or carries an unresolvable ``~`` (no ``$HOME`` / unknown user). Type errors
  on the field surface as ``bad_yaml`` instead.
- ``tier_invalid`` — per-task ``tier`` is missing, or its value is not one of
  ``TASK_TIERS`` (``medium | high | xhigh | max``). Type errors on the field
  surface as ``bad_yaml`` instead. The field is REQUIRED on every task entry
  (fn-594) — a missing ``tier:`` is bucketed under ``tier_invalid`` alongside
  unknown-value rejections; build-forward, no back-compat null default.
- ``id_collision`` — backstop: the just-allocated epic or task path already exists
- ``duplicate_epic`` — a sibling epic with the same slug already exists in this
  project. Pass ``--allow-duplicate`` to mint a distinct ``fn-N`` with the same
  slug (escape hatch; the dup-guard exists to catch the common-case planner
  mistake of re-scaffolding the same idea with the same title).
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import TypeGuard

# Pre-parse byte-size cap (1 MiB) to defend against YAML billion-laughs DoS.
# A realistic 6-task plan is ~6 KB; 1 MiB is generous yet finite.
_MAX_YAML_BYTES = 1 * 1024 * 1024


def _emit_failure(code: str, message: str, details: list[str]) -> int:
    """Emit a structured failure envelope and return exit code 1.

    Bypasses ``output.emit_error`` because that helper hard-fails on the first
    error; scaffold accumulates all errors and emits one envelope. Compact
    single-line JSON (NDJSON) matches the mutating-verb shape so downstream
    parsers behave identically on success vs failure outputs.
    """
    envelope = {
        "success": False,
        "error": {
            "code": code,
            "message": message,
            "details": details,
        },
    }
    print(json.dumps(envelope, separators=(",", ":")), flush=True)
    return 1


def _is_str(v: object) -> TypeGuard[str]:
    """YAML implicit typing guard: require an actual string, not bool/int/datetime."""
    return isinstance(v, str)


def _is_list_of_str(v: object) -> bool:
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


def _is_list_of_int(v: object) -> bool:
    # Booleans are ints in Python; reject them.
    return isinstance(v, list) and all(
        isinstance(x, int) and not isinstance(x, bool) for x in v
    )


@dataclass
class ScaffoldValidation:
    """Result of :func:`validate_scaffold_yaml` — the dry-run validation verdict.

    On success (``ok`` True): ``n_tasks`` carries the task count; ``code`` /
    ``message`` / ``details`` are unset. On failure: ``ok`` is False and the
    triplet describes the dominant error class in scaffold's exact priority
    order, with ``details`` listing every accumulated error across classes.
    """

    ok: bool
    n_tasks: int = 0
    code: str = ""
    message: str = ""
    details: list[str] = field(default_factory=list)


def validate_scaffold_yaml(
    raw_bytes: bytes, *, file_label: str, check_epic_deps: bool = True
) -> ScaffoldValidation:
    """Run scaffold's read-cap + Phase-1 parse + Phase-2 validation, no mutation.

    This is the validate half of scaffold's ``assert-all → mutate → emit`` flow,
    factored so a CALLER that wants scaffold's structural verdict WITHOUT minting
    anything (``followup submit``'s dry-run) shares the exact leaf checkers
    (:func:`_is_str`, :func:`_is_list_of_str`, :func:`_is_list_of_int`,
    ``ensure_valid_task_spec``, ``detect_cycles``, the snippet/bundle/tier
    validators) and the exact failure-code priority order scaffold itself uses.

    It does NOT allocate ids, does NOT inline ``sketch/`` refs (a mint-time
    subprocess), and does NOT run the filesystem integrity gate (``.git/``
    presence) — those are mint-only steps. ``check_epic_deps`` controls the lazy
    ``resolve_epic_globally`` existence pass for declared ``depends_on_epics``.

    Returns a :class:`ScaffoldValidation`; the caller maps a failure verdict onto
    its own envelope. Scaffold's own ``run()`` keeps its inline flow (it threads
    the parsed forward-data into the mutate phase, which this verdict does not
    carry), so the two stay behavior-identical via a divergence test rather than
    a shared parsed-data return.
    """
    from planctl.bundle_ref import BUNDLE_REF_RE, SNIPPET_ID_RE
    from planctl.deps import detect_cycles
    from planctl.ids import is_epic_id
    from planctl.models import TASK_TIERS
    from planctl.specs import ensure_valid_task_spec

    if len(raw_bytes) > _MAX_YAML_BYTES:
        return ScaffoldValidation(
            ok=False,
            code="bad_yaml",
            message=f"YAML exceeds {_MAX_YAML_BYTES} bytes (got {len(raw_bytes)})",
            details=[f"file: {file_label}"],
        )

    try:
        import yaml
    except ImportError as exc:  # pragma: no cover — pyyaml is a direct dependency
        return ScaffoldValidation(
            ok=False, code="bad_yaml", message=f"pyyaml not available: {exc}"
        )

    try:
        doc = yaml.safe_load(raw_bytes.decode("utf-8"))
    except yaml.YAMLError as exc:
        return ScaffoldValidation(
            ok=False,
            code="bad_yaml",
            message=f"YAML parse error: {exc}",
            details=[f"file: {file_label}"],
        )
    except UnicodeDecodeError as exc:
        return ScaffoldValidation(
            ok=False,
            code="bad_yaml",
            message=f"YAML is not valid UTF-8: {exc}",
            details=[f"file: {file_label}"],
        )

    errors: list[str] = []
    if not isinstance(doc, dict):
        return ScaffoldValidation(
            ok=False,
            code="bad_yaml",
            message="Top-level YAML must be a mapping with `epic:` and `tasks:` keys",
            details=[f"got: {type(doc).__name__}"],
        )

    epic_node = doc.get("epic")
    tasks_node = doc.get("tasks")
    if not isinstance(epic_node, dict):
        errors.append("epic: must be a mapping")
        epic_node = {}
    if not isinstance(tasks_node, list):
        errors.append("tasks: must be a list")
        tasks_node = []
    if errors:
        return ScaffoldValidation(
            ok=False,
            code="bad_yaml",
            message="Invalid scaffold YAML shape",
            details=errors,
        )

    # --- Epic-level validation (mirrors scaffold run() Phase 2) -------------
    epic_title = epic_node.get("title")
    if not _is_str(epic_title) or not epic_title.strip():
        errors.append("epic: `title` must be a non-empty string")

    epic_branch = epic_node.get("branch")
    if epic_branch is not None and not _is_str(epic_branch):
        errors.append("epic: `branch` must be a string when present")

    epic_spec = epic_node.get("spec", "")
    if not _is_str(epic_spec):
        errors.append("epic: `spec` must be a string (use a `|` block scalar)")

    epic_snippets = epic_node.get("snippets", [])
    if not _is_list_of_str(epic_snippets):
        errors.append("epic: `snippets` must be a list of strings")
        epic_snippets = []
    for snip in epic_snippets:
        if not SNIPPET_ID_RE.match(snip):
            errors.append(
                f"epic: snippet id {snip!r} does not match {SNIPPET_ID_RE.pattern}"
            )

    epic_bundles = epic_node.get("bundles", [])
    if not _is_list_of_str(epic_bundles):
        errors.append("epic: `bundles` must be a list of strings")
        epic_bundles = []
    for ref in epic_bundles:
        if not BUNDLE_REF_RE.match(ref):
            errors.append(
                f"epic: bundle ref {ref!r} does not match {BUNDLE_REF_RE.pattern}"
            )

    epic_queue_jump = epic_node.get("queue_jump", False)
    if not isinstance(epic_queue_jump, bool):
        errors.append("epic: `queue_jump` must be a boolean (true|false) when present")

    epic_dep_errors: list[str] = []
    depends_on_epics = epic_node.get("depends_on_epics", [])
    if not _is_list_of_str(depends_on_epics):
        epic_dep_errors.append("epic: `depends_on_epics` must be a list of strings")
        depends_on_epics = []
    else:
        seen_deps: set[str] = set()
        for dep_id in depends_on_epics:
            if not is_epic_id(dep_id):
                epic_dep_errors.append(
                    f"epic: depends_on_epics id {dep_id!r} is not a valid epic id"
                )
            if dep_id in seen_deps:
                epic_dep_errors.append(
                    f"epic: depends_on_epics id {dep_id!r} is duplicated"
                )
            seen_deps.add(dep_id)

    # --- Task-level validation --------------------------------------------
    n_tasks = len(tasks_node)
    if n_tasks == 0:
        errors.append("tasks: must contain at least one entry")

    task_deps_list: list[list[int]] = []
    spec_errors: list[str] = []
    dep_errors: list[str] = []
    ref_errors: list[str] = []
    repo_errors: list[str] = []
    tier_errors: list[str] = []

    for i, entry in enumerate(tasks_node, start=1):
        prefix = f"task #{i}"
        if not isinstance(entry, dict):
            errors.append(f"{prefix}: must be a mapping")
            task_deps_list.append([])
            continue

        title = entry.get("title")
        if not _is_str(title) or not title.strip():
            errors.append(f"{prefix}: `title` must be a non-empty string")

        spec = entry.get("spec")
        if not _is_str(spec) or not spec.strip():
            spec_errors.append(f"{prefix}: `spec` must be a non-empty string")
        else:
            try:
                ensure_valid_task_spec(spec)
            except ValueError as exc:
                spec_errors.append(f"{prefix}: spec invalid: {exc}")

        snippets = entry.get("snippets", [])
        if not _is_list_of_str(snippets):
            ref_errors.append(f"{prefix}: `snippets` must be a list of strings")
        else:
            for snip in snippets:
                if not SNIPPET_ID_RE.match(snip):
                    ref_errors.append(
                        f"{prefix}: snippet id {snip!r} does not match {SNIPPET_ID_RE.pattern}"
                    )

        bundles = entry.get("bundles", [])
        if not _is_list_of_str(bundles):
            ref_errors.append(f"{prefix}: `bundles` must be a list of strings")
        else:
            for ref in bundles:
                if not BUNDLE_REF_RE.match(ref):
                    ref_errors.append(
                        f"{prefix}: bundle ref {ref!r} does not match {BUNDLE_REF_RE.pattern}"
                    )

        deps = entry.get("deps", [])
        if not _is_list_of_int(deps):
            dep_errors.append(
                f"{prefix}: `deps` must be a list of 1-based ordinal integers"
            )
            deps = []
        else:
            for ord_val in deps:
                if ord_val < 1 or ord_val > n_tasks:
                    dep_errors.append(
                        f"{prefix}: dep ordinal {ord_val} out of range (must be 1..{n_tasks})"
                    )
                elif ord_val == i:
                    dep_errors.append(
                        f"{prefix}: dep ordinal {ord_val} is self-referential"
                    )
        task_deps_list.append(list(deps))

        target_repo_raw = entry.get("target_repo")
        if target_repo_raw is not None:
            if not _is_str(target_repo_raw):
                errors.append(f"{prefix}: `target_repo` must be a string when present")
            else:
                stripped = target_repo_raw.strip()
                if not stripped:
                    repo_errors.append(
                        f"{prefix}: `target_repo` must be non-empty after strip"
                    )
                elif not (stripped.startswith("/") or stripped.startswith("~")):
                    repo_errors.append(
                        f"{prefix}: `target_repo` {target_repo_raw!r} must be an "
                        "absolute path (starts with / or ~)"
                    )

        tier_raw = entry.get("tier")
        if tier_raw is None:
            tier_errors.append(
                f"{prefix}: `tier` is required (missing) — must be one of "
                f"{', '.join(TASK_TIERS)}"
            )
        elif not _is_str(tier_raw):
            errors.append(f"{prefix}: `tier` must be a string")
        elif tier_raw not in TASK_TIERS:
            tier_errors.append(
                f"{prefix}: `tier` {tier_raw!r} is not one of {', '.join(TASK_TIERS)}"
            )

    # Failure-code priority order — identical to scaffold's run().
    if errors:
        all_errors = (
            errors
            + ref_errors
            + spec_errors
            + dep_errors
            + epic_dep_errors
            + repo_errors
            + tier_errors
        )
        return ScaffoldValidation(
            ok=False,
            code="bad_yaml",
            message="Invalid scaffold YAML shape",
            details=all_errors,
        )

    if check_epic_deps and depends_on_epics and not epic_dep_errors:
        from planctl.discovery import resolve_epic_globally

        for dep_id in depends_on_epics:
            dep_resolution = resolve_epic_globally(dep_id)
            if dep_resolution.ambiguous:
                owners = ", ".join(str(p) for p in dep_resolution.owners)
                epic_dep_errors.append(
                    f"epic: depends_on_epics id {dep_id!r} resolves to "
                    f"multiple projects: {owners}"
                )
            elif not dep_resolution.resolved:
                epic_dep_errors.append(
                    f"epic: depends_on_epics id {dep_id!r} does not exist"
                )

    if spec_errors:
        return ScaffoldValidation(
            ok=False,
            code="spec_invalid",
            message="One or more task specs failed validation",
            details=spec_errors
            + ref_errors
            + dep_errors
            + epic_dep_errors
            + repo_errors
            + tier_errors,
        )
    if ref_errors:
        return ScaffoldValidation(
            ok=False,
            code="ref_invalid",
            message="One or more snippet/bundle refs are invalid",
            details=ref_errors
            + dep_errors
            + epic_dep_errors
            + repo_errors
            + tier_errors,
        )
    if dep_errors:
        return ScaffoldValidation(
            ok=False,
            code="dep_invalid",
            message="One or more task dependencies are invalid",
            details=dep_errors + epic_dep_errors + repo_errors + tier_errors,
        )
    if epic_dep_errors:
        return ScaffoldValidation(
            ok=False,
            code="epic_dep_invalid",
            message="One or more epic-level dependencies are invalid",
            details=epic_dep_errors + repo_errors + tier_errors,
        )
    if repo_errors:
        return ScaffoldValidation(
            ok=False,
            code="repo_invalid",
            message="One or more task `target_repo` values are invalid",
            details=repo_errors + tier_errors,
        )
    if tier_errors:
        return ScaffoldValidation(
            ok=False,
            code="tier_invalid",
            message="One or more task `tier` values are invalid",
            details=tier_errors,
        )

    # --- Cycle detection on the in-memory ordinal graph -------------------
    graph: dict[str, dict] = {
        str(i): {"depends_on": [str(d) for d in task_deps_list[i - 1]]}
        for i in range(1, n_tasks + 1)
    }
    cycle = detect_cycles(graph)
    if cycle:
        return ScaffoldValidation(
            ok=False,
            code="dep_cycle",
            message="Task dependency graph contains a cycle",
            details=[f"cycle: {' -> '.join(cycle)}"],
        )

    return ScaffoldValidation(ok=True, n_tasks=n_tasks)


def run(args: SimpleNamespace) -> int:  # noqa: PLR0911, PLR0912, PLR0915 — single transactional flow
    from planctl.bundle_ref import BUNDLE_REF_RE, SNIPPET_ID_RE
    from planctl.deps import detect_cycles
    from planctl.ids import generate_suffix, is_epic_id, scan_max_epic_id, slugify
    from planctl.models import TASK_TIERS
    from planctl.output import emit
    from planctl.project import resolve_project
    from planctl.repo_inference import expand_path
    from planctl.run_epic_create import _check_global_name_unique, _epic_id_lock
    from planctl.specs import ensure_valid_task_spec
    from planctl.store import atomic_write, atomic_write_json, load_json, now_iso

    file_arg: str = args.file
    # fn-623 dup guard escape hatch: when set, scaffold mints a distinct fn-N
    # even when a sibling epic with the same slug already exists. Defaults to
    # False so the common-case planner mistake (re-scaffolding the same idea
    # with the same title) hard-errors with ``duplicate_epic`` and the human
    # has to opt in explicitly. Threaded from cli.scaffold_cmd via SimpleNamespace.
    allow_duplicate: bool = getattr(args, "allow_duplicate", False)

    # fn-15: internal-only close-provenance stamp. When the /plan:close saga's
    # scaffold step (run_close_finalize._scaffold_followup) mints a follow-up
    # epic, it threads the source epic id here so the minted epic JSON carries
    # ``created_by_close_of: <source>`` — the positive provenance signal
    # close-finalize._find_followup_epic discovers on. Read defensively (same
    # pattern as allow_duplicate): the CLI scaffold_cmd supplies NO flag and the
    # followup.yaml schema knows NOTHING of it, so a hand-authored plan can never
    # spoof provenance. None when absent (plain scaffold) → no stamp written.
    created_by_close_of: str | None = getattr(args, "created_by_close_of", None)

    # fn-630 (a): fail closed on a missing CLAUDE_CODE_SESSION_ID BEFORE any write.
    # build_planctl_invocation (Phase 5) is the SOLE consumer of this env var and
    # runs AFTER the full epic tree is already on disk. A missing session id used
    # to let scaffold write the complete tree, then raise at the commit boundary,
    # orphaning an UNCOMMITTED epic — exactly the orphan-epic class fn-623 set out
    # to kill, via a path its atomicity fix never covered (it stopped at the
    # _epic_id_lock boundary and never extended over Phase 5). Hoisting the check
    # here keeps the assert-all -> mutate -> emit contract honest: no resolvable
    # session id => zero filesystem mutation. build_planctl_invocation re-checks
    # this and stays the authoritative raise; this is the early fail-closed guard.
    if not os.environ.get("CLAUDE_CODE_SESSION_ID"):
        return _emit_failure(
            "missing_session_id",
            "CLAUDE_CODE_SESSION_ID is unset; scaffold cannot build its commit "
            "envelope and refuses to write a tree it could not commit. The claude "
            "binary ships it intrinsically inside a Claude harness; tests and "
            "manual invocations must set it themselves.",
            [],
        )

    # ------------------------------------------------------------------
    # Phase 1: parse YAML (guarded by byte-cap)
    # ------------------------------------------------------------------
    # `--file -` reads YAML bytes from stdin (1 MiB cap applies pre-decode via
    # `sys.stdin.buffer.read()` so the universal-newlines text-mode rewrite
    # does not undercount).  TTY-interactive stdin is rejected to avoid a
    # silent hang waiting for keyboard input.
    if file_arg == "-":
        if sys.stdin.isatty():
            return _emit_failure(
                "bad_yaml",
                "stdin is a TTY — pass `--file <path>` or pipe YAML on stdin",
                ["file: -"],
            )
        try:
            raw_bytes = sys.stdin.buffer.read(_MAX_YAML_BYTES + 1)
        except OSError as exc:
            return _emit_failure(
                "bad_yaml",
                f"Could not read YAML from stdin: {exc}",
                ["file: -"],
            )
    else:
        file_path = Path(file_arg)
        try:
            raw_bytes = file_path.read_bytes()
        except OSError as exc:
            return _emit_failure(
                "bad_yaml",
                f"Could not read YAML file: {exc}",
                [f"file: {file_arg}"],
            )

    if len(raw_bytes) > _MAX_YAML_BYTES:
        return _emit_failure(
            "bad_yaml",
            f"YAML file exceeds {_MAX_YAML_BYTES} bytes (got {len(raw_bytes)})",
            [f"file: {file_arg}"],
        )

    try:
        import yaml
    except ImportError as exc:  # pragma: no cover — pyyaml is a direct dependency
        return _emit_failure(
            "bad_yaml",
            f"pyyaml not available: {exc}",
            [],
        )

    try:
        doc = yaml.safe_load(raw_bytes.decode("utf-8"))
    except yaml.YAMLError as exc:
        return _emit_failure(
            "bad_yaml",
            f"YAML parse error: {exc}",
            [f"file: {file_arg}"],
        )
    except UnicodeDecodeError as exc:
        return _emit_failure(
            "bad_yaml",
            f"YAML file is not valid UTF-8: {exc}",
            [f"file: {file_arg}"],
        )

    # ------------------------------------------------------------------
    # Phase 2: validate shape — accumulate ALL errors before returning
    # ------------------------------------------------------------------
    errors: list[str] = []

    if not isinstance(doc, dict):
        return _emit_failure(
            "bad_yaml",
            "Top-level YAML must be a mapping with `epic:` and `tasks:` keys",
            [f"got: {type(doc).__name__}"],
        )

    epic_node = doc.get("epic")
    tasks_node = doc.get("tasks")

    if not isinstance(epic_node, dict):
        errors.append("epic: must be a mapping")
        epic_node = {}
    if not isinstance(tasks_node, list):
        errors.append("tasks: must be a list")
        tasks_node = []

    if errors:
        return _emit_failure("bad_yaml", "Invalid scaffold YAML shape", errors)

    # --- Epic-level validation ----------------------------------------
    epic_title = epic_node.get("title")
    if not _is_str(epic_title) or not epic_title.strip():
        errors.append("epic: `title` must be a non-empty string")
        epic_title = ""

    epic_branch = epic_node.get("branch")
    if epic_branch is not None and not _is_str(epic_branch):
        errors.append("epic: `branch` must be a string when present")

    epic_spec = epic_node.get("spec", "")
    if not _is_str(epic_spec):
        errors.append("epic: `spec` must be a string (use a `|` block scalar)")

    epic_snippets = epic_node.get("snippets", [])
    if not _is_list_of_str(epic_snippets):
        errors.append("epic: `snippets` must be a list of strings")
        epic_snippets = []
    for snip in epic_snippets:
        if not SNIPPET_ID_RE.match(snip):
            errors.append(
                f"epic: snippet id {snip!r} does not match {SNIPPET_ID_RE.pattern}"
            )

    epic_bundles = epic_node.get("bundles", [])
    if not _is_list_of_str(epic_bundles):
        errors.append("epic: `bundles` must be a list of strings")
        epic_bundles = []
    for ref in epic_bundles:
        if not BUNDLE_REF_RE.match(ref):
            errors.append(
                f"epic: bundle ref {ref!r} does not match {BUNDLE_REF_RE.pattern}"
            )

    # fn-595: queue_jump is optional and bool-only. Bucket type errors under
    # `bad_yaml` (alongside `branch` / `spec` / `snippets` / `bundles`); the
    # missing-key path defaults to False so /plan:defer YAML omitting the key
    # entirely is the canonical "no queue jump" shape. Missing on legacy YAML
    # is normal — only an explicit non-bool value is an error.
    epic_queue_jump = epic_node.get("queue_jump", False)
    if not isinstance(epic_queue_jump, bool):
        errors.append("epic: `queue_jump` must be a boolean (true|false) when present")
        epic_queue_jump = False

    # --- Epic-dep validation (type / id-shape / dup; existence is deferred to
    # the lazy disk check below so the no-deps path stays pure-in-memory) -----
    epic_dep_errors: list[str] = []
    depends_on_epics = epic_node.get("depends_on_epics", [])
    if not _is_list_of_str(depends_on_epics):
        epic_dep_errors.append("epic: `depends_on_epics` must be a list of strings")
        depends_on_epics = []
    else:
        seen_deps: set[str] = set()
        for dep_id in depends_on_epics:
            if not is_epic_id(dep_id):
                epic_dep_errors.append(
                    f"epic: depends_on_epics id {dep_id!r} is not a valid epic id"
                )
            if dep_id in seen_deps:
                epic_dep_errors.append(
                    f"epic: depends_on_epics id {dep_id!r} is duplicated"
                )
            seen_deps.add(dep_id)

    # --- Task-level validation (per-entry, all errors accumulated) ----
    n_tasks = len(tasks_node)
    if n_tasks == 0:
        errors.append("tasks: must contain at least one entry")

    # First pass: collect typed errors per task. Build the dep ordinal map only
    # after we've validated the entire tasks list is well-formed; otherwise the
    # 1-based ordinal arithmetic could collide with malformed entries.
    task_titles: list[str] = []
    task_specs: list[str] = []
    task_snippets_list: list[list[str]] = []
    task_bundles_list: list[list[str]] = []
    task_deps_list: list[list[int]] = []  # 1-based ordinals
    # None ⇒ omitted → defaults to primary_repo at mutate time.
    # str ⇒ already canonicalised (expand_path) absolute path.
    task_target_repos: list[str | None] = []
    # Each entry is a validated TASK_TIERS member (str). fn-594: tier is
    # REQUIRED on every task entry — missing or unknown values are bucketed
    # under `tier_invalid` upstream. Placeholder ""s land here only on entries
    # that already failed an earlier check (shape error / non-string), in which
    # case the verb has already accumulated an envelope-failing error and the
    # task_def write path is unreachable.
    task_tiers: list[str] = []

    spec_errors: list[str] = []
    dep_errors: list[str] = []
    ref_errors: list[str] = []
    repo_errors: list[str] = []
    tier_errors: list[str] = []

    for i, entry in enumerate(tasks_node, start=1):
        prefix = f"task #{i}"
        if not isinstance(entry, dict):
            errors.append(f"{prefix}: must be a mapping")
            # Push placeholders so positional indexing stays aligned.
            task_titles.append("")
            task_specs.append("")
            task_snippets_list.append([])
            task_bundles_list.append([])
            task_deps_list.append([])
            task_target_repos.append(None)
            task_tiers.append("")
            continue

        title = entry.get("title")
        if not _is_str(title) or not title.strip():
            errors.append(f"{prefix}: `title` must be a non-empty string")
            title = ""
        task_titles.append(title if isinstance(title, str) else "")

        spec = entry.get("spec")
        if not _is_str(spec) or not spec.strip():
            spec_errors.append(f"{prefix}: `spec` must be a non-empty string")
            spec = ""
        else:
            # Validate the four required sections upfront.
            try:
                ensure_valid_task_spec(spec)
            except ValueError as exc:
                spec_errors.append(f"{prefix}: spec invalid: {exc}")
        task_specs.append(spec)

        snippets = entry.get("snippets", [])
        if not _is_list_of_str(snippets):
            ref_errors.append(f"{prefix}: `snippets` must be a list of strings")
            snippets = []
        else:
            for snip in snippets:
                if not SNIPPET_ID_RE.match(snip):
                    ref_errors.append(
                        f"{prefix}: snippet id {snip!r} does not match {SNIPPET_ID_RE.pattern}"
                    )
        task_snippets_list.append(list(snippets))

        bundles = entry.get("bundles", [])
        if not _is_list_of_str(bundles):
            ref_errors.append(f"{prefix}: `bundles` must be a list of strings")
            bundles = []
        else:
            for ref in bundles:
                if not BUNDLE_REF_RE.match(ref):
                    ref_errors.append(
                        f"{prefix}: bundle ref {ref!r} does not match {BUNDLE_REF_RE.pattern}"
                    )
        task_bundles_list.append(list(bundles))

        deps = entry.get("deps", [])
        if not _is_list_of_int(deps):
            dep_errors.append(
                f"{prefix}: `deps` must be a list of 1-based ordinal integers"
            )
            deps = []
        else:
            for ord_val in deps:
                if ord_val < 1 or ord_val > n_tasks:
                    dep_errors.append(
                        f"{prefix}: dep ordinal {ord_val} out of range (must be 1..{n_tasks})"
                    )
                elif ord_val == i:
                    dep_errors.append(
                        f"{prefix}: dep ordinal {ord_val} is self-referential"
                    )
        task_deps_list.append(list(deps))

        # Optional per-task `target_repo`. Absent ⇒ defaults to primary_repo at
        # mutate time. Type errors are shape failures (`bad_yaml`); resolution
        # failures (relative path, empty-after-strip, unresolvable ~) surface
        # as `repo_invalid`. No filesystem checks at scaffold time — defer to
        # `validate --epic` and worker spawn (artbird auto-deploy ships epic
        # JSON between machines, so paths must stay portable).
        target_repo_raw = entry.get("target_repo")
        if target_repo_raw is None:
            task_target_repos.append(None)
        elif not _is_str(target_repo_raw):
            errors.append(f"{prefix}: `target_repo` must be a string when present")
            task_target_repos.append(None)
        else:
            stripped = target_repo_raw.strip()
            if not stripped:
                repo_errors.append(
                    f"{prefix}: `target_repo` must be non-empty after strip"
                )
                task_target_repos.append(None)
            elif not (stripped.startswith("/") or stripped.startswith("~")):
                repo_errors.append(
                    f"{prefix}: `target_repo` {target_repo_raw!r} must be an "
                    "absolute path (starts with / or ~)"
                )
                task_target_repos.append(None)
            else:
                try:
                    task_target_repos.append(expand_path(stripped))
                except RuntimeError as exc:
                    # `Path.expanduser()` raises RuntimeError when ~ cannot be
                    # resolved — no $HOME in container envs, or ~unknownuser.
                    repo_errors.append(
                        f"{prefix}: `target_repo` {target_repo_raw!r} could not be "
                        f"expanded: {exc}"
                    )
                    task_target_repos.append(None)

        # Required per-task `tier` (fn-593, hardened by fn-594). Missing field
        # and unknown-value both surface as `tier_invalid` — single bucket,
        # matches the `dep_invalid` / `spec_invalid` per-category pattern.
        # Type errors (non-string) remain shape failures (`bad_yaml`). Tier is
        # runtime metadata (not in VALIDATION_RESTAMP_VERBS); scaffold just
        # propagates the planner's deliberate choice into the persisted
        # task_def. Build-forward: no back-compat null default — legacy
        # on-disk null-tier records remediate via `/plan:plan <epic_id>` refine.
        tier_raw = entry.get("tier")
        if tier_raw is None:
            tier_errors.append(
                f"{prefix}: `tier` is required (missing) — must be one of "
                f"{', '.join(TASK_TIERS)}"
            )
            task_tiers.append("")
        elif not _is_str(tier_raw):
            errors.append(f"{prefix}: `tier` must be a string")
            task_tiers.append("")
        elif tier_raw not in TASK_TIERS:
            tier_errors.append(
                f"{prefix}: `tier` {tier_raw!r} is not one of {', '.join(TASK_TIERS)}"
            )
            task_tiers.append("")
        else:
            task_tiers.append(tier_raw)

    # Decide failure codes in a stable priority order so a single envelope
    # surfaces the dominant class. Other-class errors still appear in details.
    all_errors = (
        errors
        + ref_errors
        + spec_errors
        + dep_errors
        + epic_dep_errors
        + repo_errors
        + tier_errors
    )
    if errors:
        # Shape/type errors short-circuit (`bad_yaml`) — graph integrity below
        # is meaningless when the basic shape is wrong.
        return _emit_failure(
            "bad_yaml",
            "Invalid scaffold YAML shape",
            all_errors,
        )

    # Lazy epic-dep existence check: only touch disk when deps are declared,
    # keeping the no-deps common path pure-in-memory. Type/shape/dup errors
    # accumulated above are joined here so one envelope surfaces them all.
    # fn-600: resolve cwd-then-global so a declared cross-project dep
    # resolves cleanly (the cwd hot path catches the common local case, the
    # global step catches the cross-project case). Ambiguous-id (legacy dup
    # state) surfaces as ``dep_ambiguous_id`` listing every owning project.
    if depends_on_epics and not epic_dep_errors:
        from planctl.discovery import resolve_epic_globally

        # fn-20: normalize each declared dep to its resolved FULL slug id so a
        # number-only ``fn-N`` declaration persists canonically. Only rebind
        # when every dep resolves cleanly (no ambiguous / not-found error).
        normalized_deps: list[str] = []
        for dep_id in depends_on_epics:
            dep_resolution = resolve_epic_globally(dep_id)
            if dep_resolution.ambiguous:
                owners = ", ".join(str(p) for p in dep_resolution.owners)
                epic_dep_errors.append(
                    f"epic: depends_on_epics id {dep_id!r} resolves to "
                    f"multiple projects: {owners}"
                )
            elif not dep_resolution.resolved:
                epic_dep_errors.append(
                    f"epic: depends_on_epics id {dep_id!r} does not exist"
                )
            else:
                assert dep_resolution.resolved_id is not None
                normalized_deps.append(dep_resolution.resolved_id)
        if not epic_dep_errors:
            depends_on_epics = normalized_deps

    if spec_errors:
        return _emit_failure(
            "spec_invalid",
            "One or more task specs failed validation",
            spec_errors
            + ref_errors
            + dep_errors
            + epic_dep_errors
            + repo_errors
            + tier_errors,
        )
    if ref_errors:
        return _emit_failure(
            "ref_invalid",
            "One or more snippet/bundle refs are invalid",
            ref_errors + dep_errors + epic_dep_errors + repo_errors + tier_errors,
        )
    if dep_errors:
        return _emit_failure(
            "dep_invalid",
            "One or more task dependencies are invalid",
            dep_errors + epic_dep_errors + repo_errors + tier_errors,
        )
    if epic_dep_errors:
        return _emit_failure(
            "epic_dep_invalid",
            "One or more epic-level dependencies are invalid",
            epic_dep_errors + repo_errors + tier_errors,
        )
    if repo_errors:
        return _emit_failure(
            "repo_invalid",
            "One or more task `target_repo` values are invalid",
            repo_errors + tier_errors,
        )
    if tier_errors:
        return _emit_failure(
            "tier_invalid",
            "One or more task `tier` values are invalid",
            tier_errors,
        )

    # --- fn-610 / fn-628: inline `sketch/` refs at write time ----------
    # Resolve every `sketch/<name>` ref against the cwd-derived project
    # (where /sketch saved the sketch). Inlined ids fold into the
    # record's `snippets`; the sketch ref is dropped from `bundles` so
    # worker-time `render-spec` never re-resolves it. The resolver runs
    # in a subprocess (`promptctl inline-sketch-refs`) — see
    # `planctl/sketch_refs.py` — so planctl carries zero in-repo Python
    # dependency on promptctl. ONE subprocess call covers the epic +
    # every task; per-slot ref errors map back by ordinal. Tooling
    # failure (spawn/non-zero/timeout/non-JSON) fails the whole step
    # visibly — distinct from `ref_invalid`, no fallback.
    from planctl.sketch_refs import (
        SketchRefError,
        SketchToolingError,
        _OkSlot,
        inline_sketch_refs_batch,
    )

    ctx = resolve_project()
    sketch_anchor = ctx.project_path

    # Batch shape: slot 0 = epic; slots 1..n_tasks = tasks 1..n_tasks.
    sketch_groups: list[dict[str, list[str]]] = [
        {"bundles": list(epic_bundles), "snippets": list(epic_snippets)}
    ]
    for i in range(1, n_tasks + 1):
        sketch_groups.append(
            {
                "bundles": list(task_bundles_list[i - 1]),
                "snippets": list(task_snippets_list[i - 1]),
            }
        )

    try:
        sketch_slots = inline_sketch_refs_batch(
            sketch_groups, project_root=sketch_anchor
        )
    except SketchToolingError as exc:
        return _emit_failure(
            "sketch_tooling_failed",
            "`promptctl inline-sketch-refs` failed to run",
            [str(exc), exc.stderr] if exc.stderr else [str(exc)],
        )

    sketch_errors: list[str] = []

    epic_slot = sketch_slots[0]
    if isinstance(epic_slot, SketchRefError):
        sketch_errors.append(f"epic: sketch ref {epic_slot.ref!r} {epic_slot.reason}")
        resolved_epic_bundles = list(epic_bundles)
        resolved_epic_snippets = list(epic_snippets)
    else:
        assert isinstance(epic_slot, _OkSlot)
        resolved_epic_bundles = epic_slot.remaining_bundles
        resolved_epic_snippets = epic_slot.merged_snippets

    resolved_task_bundles_list: list[list[str]] = []
    resolved_task_snippets_list: list[list[str]] = []
    for i in range(1, n_tasks + 1):
        task_slot = sketch_slots[i]
        if isinstance(task_slot, SketchRefError):
            sketch_errors.append(
                f"task #{i}: sketch ref {task_slot.ref!r} {task_slot.reason}"
            )
            # Preserve the original (bundles, snippets) so collect-all
            # surfaces every error in one envelope without earlier slots
            # poisoning later resolution decisions (matches fn-610 behavior).
            resolved_task_bundles_list.append(list(task_bundles_list[i - 1]))
            resolved_task_snippets_list.append(list(task_snippets_list[i - 1]))
        else:
            assert isinstance(task_slot, _OkSlot)
            resolved_task_bundles_list.append(task_slot.remaining_bundles)
            resolved_task_snippets_list.append(task_slot.merged_snippets)

    if sketch_errors:
        return _emit_failure(
            "ref_invalid",
            "One or more sketch refs failed to resolve",
            sketch_errors,
        )

    epic_bundles = resolved_epic_bundles
    epic_snippets = resolved_epic_snippets
    task_bundles_list = resolved_task_bundles_list
    task_snippets_list = resolved_task_snippets_list

    # --- Cycle detection on the full in-memory graph ------------------
    # Ordinals are valid (1..N, no self-ref) at this point. Build the graph
    # keyed by ordinal so cycle detection works in pre-allocation space —
    # the planned `fn-N.M` ids are not yet minted.
    graph: dict[str, dict] = {
        str(i): {"depends_on": [str(d) for d in task_deps_list[i - 1]]}
        for i in range(1, n_tasks + 1)
    }
    cycle = detect_cycles(graph)
    if cycle:
        return _emit_failure(
            "dep_cycle",
            "Task dependency graph contains a cycle",
            [f"cycle: {' -> '.join(cycle)}"],
        )

    # ------------------------------------------------------------------
    # Phase 3: allocate ids under the global flock; backstop existence
    # ------------------------------------------------------------------
    # `ctx` was resolved above for sketch anchoring (fn-610); reuse it.
    data_dir = ctx.data_dir
    primary_repo = str(ctx.project_path)

    with _epic_id_lock():
        # ----------------------------------------------------------------
        # fn-623 dup guard: reject a same-slug sibling epic up front so
        # the planner-mistake "re-scaffold the same idea with the same
        # title" surfaces as a typed error instead of silently allocating
        # a second fn-N with the same slug. Runs BEFORE id allocation /
        # any write so a rejected dup leaves `scan_max_epic_id` unchanged
        # and zero side effects on disk. `--allow-duplicate` is the
        # explicit escape hatch for the rare legitimate same-slug case.
        # `slug` is already `.lower()` via `slugify`, so the glob is
        # case-normalised; a None slug (title doesn't slugify) means the
        # random-suffix branch runs below and no dup-guard match is
        # possible.
        # ----------------------------------------------------------------
        slug = slugify(epic_title)
        if slug and not allow_duplicate:
            epics_dir = data_dir / "epics"
            if epics_dir.exists():
                # The glob is a cheap prefilter; `fn-*-{slug}.json` also
                # false-matches any epic whose slug *ends* with `-{slug}`
                # (e.g. existing `fn-3-foo-bar.json` matches the glob for
                # slug `bar` via fnmatch semantics). Pin exact-slug
                # equivalence with a fullmatch on the stem: only
                # `fn-<digits>-{slug}` (no extra dash-segments) counts as
                # a real same-slug sibling.
                exact_stem_re = re.compile(rf"fn-\d+-{re.escape(slug)}")
                dup_matches = [
                    match
                    for match in sorted(epics_dir.glob(f"fn-*-{slug}.json"))
                    if exact_stem_re.fullmatch(match.stem)
                ]
                if dup_matches:
                    details: list[str] = []
                    for match in dup_matches:
                        existing_id = match.stem
                        try:
                            existing = load_json(match)
                            existing_status = existing.get("status", "<unknown>")
                        except Exception:
                            existing_status = "<unreadable>"
                        details.append(f"{existing_id} (status: {existing_status})")
                    return _emit_failure(
                        "duplicate_epic",
                        (
                            f"An epic with slug {slug!r} already exists in this "
                            f"project; pass --allow-duplicate to mint a distinct "
                            f"fn-N anyway"
                        ),
                        details,
                    )

        max_n = scan_max_epic_id(data_dir)
        epic_num = max_n + 1
        epic_id = (
            f"fn-{epic_num}-{slug}" if slug else f"fn-{epic_num}-{generate_suffix()}"
        )
        branch_name = epic_branch or epic_id

        # Global-name uniqueness check across all discovered projects.
        foreign_owner = _check_global_name_unique(epic_id, ctx.project_path)
        if foreign_owner is not None:
            return _emit_failure(
                "id_collision",
                f"Allocated epic id {epic_id} already exists in another project",
                [f"existing owner: {foreign_owner}"],
            )

        # Backstop collision check before any write. Per-task paths are derived
        # from `epic_id.M` so a fresh epic id implies fresh task ids — but the
        # backstop catches any latent corruption (e.g. a stale tasks file from
        # an aborted earlier run with the same fn-N).
        epic_path = data_dir / "epics" / f"{epic_id}.json"
        epic_spec_path = data_dir / "specs" / f"{epic_id}.md"

        collisions: list[str] = []
        if epic_path.exists():
            collisions.append(f"epic JSON exists: {epic_path}")
        if epic_spec_path.exists():
            collisions.append(f"epic spec exists: {epic_spec_path}")
        task_paths: list[tuple[Path, Path]] = []
        for i in range(1, n_tasks + 1):
            task_id = f"{epic_id}.{i}"
            tp = data_dir / "tasks" / f"{task_id}.json"
            sp = data_dir / "specs" / f"{task_id}.md"
            if tp.exists():
                collisions.append(f"task JSON exists: {tp}")
            if sp.exists():
                collisions.append(f"task spec exists: {sp}")
            task_paths.append((tp, sp))

        if collisions:
            return _emit_failure(
                "id_collision",
                f"Allocated epic id {epic_id} would overwrite existing files",
                collisions,
            )

        # --------------------------------------------------------------
        # Phase 4: assemble in-memory tree → integrity check → write
        # --------------------------------------------------------------
        # fn-587 task .3: build the full in-memory tree first so the shared
        # ``check_epic_tree_in_memory`` helper can re-verify structural
        # integrity BEFORE any ``atomic_write_json`` lands a partial tree.
        # The check is belt-and-suspenders over scaffold's own Phase-2 YAML
        # validation — it also surfaces the multi-repo filesystem checks
        # (primary_repo ``.git/`` + samefile, touched_repos ``.git/``) that
        # scaffold's incremental shape pass deliberately skips.
        #
        # fn-623 atomicity fix: NO spec file is written to its final path
        # before the integrity gate passes. The helper accepts the epic
        # spec content in-memory via ``epic_spec_content=``; task spec
        # content already flows through as a dict. Result: a scaffold
        # that fails the integrity gate leaves zero side effects on disk
        # — ``scan_max_epic_id`` does not advance, no orphan
        # ``specs/fn-N-*.md`` to clean up.
        now = now_iso()
        # Resolve per-task target_repos: each None defaults to primary_repo.
        # epic.touched_repos is the deterministic sorted-uniq rollup — never a
        # statistical inference (the old gravity path) and never hand-edited.
        resolved_task_target_repos: list[str] = [
            tr if tr is not None else primary_repo for tr in task_target_repos
        ]
        touched_repos = sorted(set(resolved_task_target_repos))

        epic_def = {
            "id": epic_id,
            "title": epic_title,
            "status": "open",
            "branch_name": branch_name,
            "depends_on_epics": list(depends_on_epics),
            "primary_repo": primary_repo,
            "touched_repos": touched_repos,
            "snippets": list(epic_snippets),
            "bundles": list(epic_bundles),
            # fn-595: queue_jump rides the JSON for consistency, but the
            # authoritative source for keeper's projection is the
            # planctl_invocation envelope (see invocation.py
            # build_planctl_invocation + the EpicSnapshot UPDATE-omit carve-out).
            "queue_jump": epic_queue_jump,
            # last_validated_at stamped below post integrity-check.
            "last_validated_at": None,
            "created_at": now,
            "updated_at": now,
        }

        # fn-15: when the close saga supplies the source epic id, stamp positive
        # provenance onto the minted follow-up. The key rides the same
        # ``epic_def`` dict — and therefore the same single ``atomic_write_json``
        # below — so a crash leaves either no follow-up file or a complete
        # stamped one; there is no stampless-epic window. Only stamped when the
        # internal arg is supplied; plain ``planctl scaffold`` leaves it absent.
        if created_by_close_of is not None:
            epic_def["created_by_close_of"] = created_by_close_of

        # Assemble task defs in memory keyed by task_id for the integrity check.
        in_mem_task_defs: dict[str, dict] = {}
        in_mem_task_specs: dict[str, str] = {}
        for i in range(1, n_tasks + 1):
            task_id = f"{epic_id}.{i}"
            dep_ordinals = task_deps_list[i - 1]
            depends_on = [f"{epic_id}.{d}" for d in dep_ordinals]
            task_def = {
                "id": task_id,
                "epic": epic_id,
                "title": task_titles[i - 1],
                "priority": None,
                "depends_on": depends_on,
                "target_repo": resolved_task_target_repos[i - 1],
                # fn-593: planner-chosen tier rides the scaffold YAML through
                # to the persisted task_def. fn-594 made the field required at
                # mint time — every value reaching here is a validated
                # TASK_TIERS member (the missing / unknown / non-string paths
                # accumulated envelope-failing errors above and never made it
                # to this write site).
                "tier": task_tiers[i - 1],
                "snippets": list(task_snippets_list[i - 1]),
                "bundles": list(task_bundles_list[i - 1]),
                "created_at": now,
                "updated_at": now,
            }
            in_mem_task_defs[task_id] = task_def
            in_mem_task_specs[task_id] = task_specs[i - 1]

        # Build the all-epic-ids set (includes any sibling epics on disk plus
        # this newly-minted id) so ``depends_on_epics`` existence is checked
        # against the right universe.  Also build the parallel
        # ``{epic_id: depends_on_epics}`` map so the integrity helper can run
        # its epic-dep cycle check against the project-wide graph (with the
        # newly-minted epic's deps overlaid on top).
        existing_epic_ids: set[str] = set()
        existing_epic_deps: dict[str, list[str]] = {}
        epics_glob_dir = data_dir / "epics"
        if epics_glob_dir.exists():
            for _f in epics_glob_dir.glob("*.json"):
                existing_epic_ids.add(_f.stem)
                _ep = load_json(_f)
                existing_epic_deps[_f.stem] = list(_ep.get("depends_on_epics", []))
        existing_epic_ids.add(epic_id)
        existing_epic_deps[epic_id] = list(epic_def.get("depends_on_epics", []))

        # fn-600: extend the existence + cycle universe across every
        # discovered project so a cross-project dep declared in the YAML
        # passes the integrity helper's existence check (the local
        # ``existing_epic_ids`` won't carry the sibling-project dep id), and
        # so a cross-project cycle introduced by the newly-minted deps
        # surfaces here. Fail-soft on discovery — single-repo workflows keep
        # working when no ``roots`` are configured.
        from planctl.discovery import discover_projects
        from planctl.ids import scan_epic_ids_global

        try:
            discovered = discover_projects()
        except Exception:
            discovered = []
        global_epic_ids = scan_epic_ids_global(discovered) if discovered else {}
        if discovered:
            for project in discovered:
                other_epics = project / ".planctl" / "epics"
                if not other_epics.exists():
                    continue
                for _f in other_epics.glob("*.json"):
                    if _f.stem in existing_epic_deps:
                        continue
                    _ep = load_json(_f)
                    existing_epic_deps[_f.stem] = list(_ep.get("depends_on_epics", []))

        from planctl.integrity import check_epic_tree_in_memory

        # fn-589 task .1 (item 1): the inline integrity gate now asserts
        # filesystem-repo validity (primary_repo / touched_repos / per-task
        # target_repo paths point at real ``.git/``-bearing dirs) so the
        # trailing ``planctl validate --epic`` the skill used to fire after
        # scaffold is no longer needed.  The fresh-mint tree references local
        # paths (resolved on the minting host), so the check is safe here.
        #
        # fn-623: ``epic_spec_content=epic_spec`` lets the helper assert
        # epic-spec presence from RAM instead of from
        # ``data_dir/specs/<eid>.md`` — so we have NOT written any spec
        # file yet, and the integrity gate is the last point before the
        # first ``atomic_write*`` call.
        integ_errors, _ = check_epic_tree_in_memory(
            epic_id,
            epic_def,
            in_mem_task_defs,
            in_mem_task_specs,
            data_dir=data_dir,
            all_epic_ids=existing_epic_ids,
            all_epic_deps=existing_epic_deps,
            all_global_epic_ids=global_epic_ids,
            check_filesystem_repos=True,
            epic_spec_content=epic_spec,
        )

        if integ_errors:
            # fn-623: nothing was written before the gate — no rollback to
            # do. ``scan_max_epic_id`` is unchanged (no ``epics/`` or
            # ``specs/`` file landed for this epic_id) and the verb is a
            # pure no-op on disk.
            return _emit_failure(
                "integrity_failed",
                "Scaffold integrity check failed against the in-memory tree",
                integ_errors,
            )

        # Integrity passed — stamp last_validated_at and write the whole tree.
        # All writes from this point on live inside a try/finally that
        # unwinds partially-landed files on any exception (KeyboardInterrupt,
        # disk-full, etc.) so the gate's "zero orphans on failure" invariant
        # extends through the write phase too.
        epic_def["last_validated_at"] = now_iso()
        written_paths: list[Path] = []
        try:
            atomic_write_json(epic_path, epic_def)
            written_paths.append(epic_path)
            atomic_write(epic_spec_path, epic_spec)
            written_paths.append(epic_spec_path)
            for i in range(1, n_tasks + 1):
                task_id = f"{epic_id}.{i}"
                tp, sp = task_paths[i - 1]
                atomic_write(sp, task_specs[i - 1])
                written_paths.append(sp)
                atomic_write_json(tp, in_mem_task_defs[task_id])
                written_paths.append(tp)
        except BaseException:
            # Unwind any files that did land before the failure so a
            # mid-write crash doesn't orphan ``specs/fn-N-*.md`` (which
            # would advance ``scan_max_epic_id``). ``missing_ok=True``
            # because the partial write may have failed before rename.
            import contextlib

            for p in written_paths:
                with contextlib.suppress(OSError):
                    p.unlink(missing_ok=True)
            raise

    # ------------------------------------------------------------------
    # Phase 5: emit ONE envelope covering the whole tree
    # ------------------------------------------------------------------
    # The central seam at output.emit() owns the invocation build + commit.
    # emit(verb=...) builds build_planctl_invocation internally and runs the
    # per-verb auto-commit. The local write-phase try/except above already
    # unwound any partial tree on a MID-WRITE crash; a pre-commit raise from
    # the seam (invocation-build failure, git error) leaves the fully-written
    # tree on disk (§10 no-rollback) — the keeper HEAD-gate keeps it invisible
    # to the autopilot until it reaches HEAD. The emit() call runs OUTSIDE
    # ``_epic_id_lock`` (the lock's ``with`` block closed above) so the
    # sub-millisecond id-allocation lock stays off the git-commit critical
    # path.
    task_ids = [f"{epic_id}.{i}" for i in range(1, n_tasks + 1)]
    # Per-task repo distribution: deterministic {repo_path: count} map built
    # from the in-scope resolved list (None -> primary_repo already applied).
    # Top-level sibling of epic_id/task_ids — wire-safe (keeper reads only
    # planctl_invocation.{op,target,subject,queue_jump}).
    repo_distribution = dict(sorted(Counter(resolved_task_target_repos).items()))

    scaffold_data: dict = {
        "epic_id": epic_id,
        "task_ids": task_ids,
        "repo_distribution": repo_distribution,
    }

    emit(
        scaffold_data,
        verb="scaffold",
        target=epic_id,
        repo_root=ctx.project_path,
        primary_repo=primary_repo,
        queue_jump=epic_queue_jump,
    )
    return 0


def main() -> int:  # pragma: no cover — module-level helper (rare manual call)
    """Allow ``python -m planctl.run_scaffold`` smoke tests."""
    import argparse

    parser = argparse.ArgumentParser(description="planctl scaffold")
    parser.add_argument("--file", required=True)
    parser.add_argument(
        "--allow-duplicate",
        action="store_true",
        help=(
            "Mint a distinct fn-N even when an epic with the same slug "
            "already exists in this project (fn-623 escape hatch)."
        ),
    )
    ns = parser.parse_args()
    args = SimpleNamespace(file=ns.file, allow_duplicate=ns.allow_duplicate)
    return run(args)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
